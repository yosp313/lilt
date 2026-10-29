import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  powerMonitor,
  safeStorage,
  session,
  shell,
} from 'electron';
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import started from 'electron-squirrel-startup';
import type {
  AiCompleteRequest,
  AiConfig,
  CalendarConnectRequest,
  CalendarEvent,
  CalendarStatus,
  Store,
  SttSource,
  TranscribeRequest,
} from './shared/types.ts';
import {
  escapeHtml,
  isLocalEndpoint,
  LOCAL_STT_MODELS,
  localSttSource,
  mapGoogleEvents,
  mapMicrosoftEvents,
  sanitizeSharedNote,
  sharedNoteFor,
  shouldImportFallback,
  type LocalSttSource,
} from './shared/logic.ts';
import {
  downloadLocalModel,
  localModelReady,
  localServerTranscribe,
  localTranscribe,
  stopLocalServer,
} from './local-stt.ts';
import { createSeed } from './shared/seed.ts';
import crypto from 'node:crypto';
import { startMeetingPolling } from './meeting-detection.ts';
import { registerAudioRetentionIpc } from './audio-retention.ts';

if (started) app.quit();

app.setName('Lilt');

const hasLock = app.requestSingleInstanceLock();
if (!hasLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = BrowserWindow.getAllWindows()[0];
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });
}

const dataDir = () => app.getPath('userData');
const storePath = () => path.join(dataDir(), 'store.json');
const aiConfigPath = () => path.join(dataDir(), 'ai-config.json');
const isDev = Boolean(MAIN_WINDOW_VITE_DEV_SERVER_URL);

interface StoredAiConfig {
  baseUrl: string;
  sttServerUrl: string;
  chatModel: string;
  thinkingModel: string;
  sttModel: string;
  sttLanguage: string;
  sttSource: SttSource;
  keyEncrypted?: string;
}

const DEFAULT_AI: StoredAiConfig = {
  baseUrl: 'https://api.openai.com/v1',
  sttServerUrl: 'http://127.0.0.1:8080',
  chatModel: 'gpt-4.1-mini',
  thinkingModel: 'gpt-4.1',
  sttModel: 'whisper-1',
  sttLanguage: 'en',
  sttSource: 'whisper-small',
};

let storeCache: Store;
let memoryKey = '';
let sharePort = 0;
let shareServer: http.Server | null = null;
let saveQueue: Promise<void> = Promise.resolve();

async function readStore(): Promise<Store> {
  try {
    const parsed = JSON.parse(
      await fs.promises.readFile(storePath(), 'utf8'),
    ) as Store;
    if (!isStore(parsed)) throw new Error('Store is missing required fields');
    // Legacy subscription fields are no longer part of the personal build.
    delete (parsed.workspace as { plan?: unknown }).plan;
    delete (parsed.workspace as { domain?: unknown }).domain;
    delete (parsed.settings as { historyDays?: unknown }).historyDays;
    for (const note of parsed.notes) {
      if (note.share) {
        const mode = (note.share as { mode?: string }).mode;
        if (mode !== 'off' && mode !== 'anyone') {
          note.share = { mode: 'off', token: null };
        }
        if ('invited' in note.share) {
          delete (note.share as { invited?: unknown }).invited;
        }
      }
    }
    return parsed;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      const seed = createSeed();
      await writeStore(seed);
      return seed;
    }
    const backup = path.join(dataDir(), `store.corrupt-${Date.now()}.json`);
    let backedUp = false;
    try {
      await fs.promises.copyFile(storePath(), backup);
      await fs.promises.chmod(backup, 0o600);
      backedUp = true;
    } catch (copyError) {
      console.error('Store could not be backed up', copyError);
    }
    console.error(
      `Store could not be read${backedUp ? `; backup at ${backup}` : ''}`,
      error,
    );
    throw new Error(
      backedUp
        ? `Your notes file could not be read. A copy was saved at ${backup}.`
        : 'Your notes file could not be read. It was left untouched.',
    );
  }
}

function isStore(value: unknown): value is Store {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Store;
  return (
    Array.isArray(candidate.notes) &&
    Array.isArray(candidate.spaces) &&
    Array.isArray(candidate.folders) &&
    Array.isArray(candidate.templates) &&
    Boolean(candidate.workspace) &&
    Boolean(candidate.settings)
  );
}

function writeStore(store: Store, fallback = false): Promise<string> {
  storeCache = store;
  const savedAt = new Date().toISOString();
  // Mark fallback writes so a startup seed (or migrated JSON) is never
  // mistaken for a newer save and imported over IndexedDB.
  const body = JSON.stringify(
    fallback ? { ...store, fallbackSavedAt: savedAt } : store,
  );
  const next = saveQueue.then(async () => {
    const tmp = storePath() + '.tmp';
    await fs.promises.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
    await fs.promises.chmod(tmp, 0o600).catch(() => {});
    await fs.promises.rename(tmp, storePath());
  });
  saveQueue = next.catch(() => {});
  return next.then(() => savedAt);
}

function readAiConfig(): StoredAiConfig {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(aiConfigPath(), 'utf8'),
    ) as StoredAiConfig;
    const config = { ...DEFAULT_AI, ...parsed };
    if (
      config.sttSource !== 'cloud' &&
      config.sttSource !== 'local-server' &&
      localSttSource(config.sttSource) === null
    ) {
      config.sttSource = DEFAULT_AI.sttSource;
    }
    return config;
  } catch {
    return { ...DEFAULT_AI };
  }
}

function writeAiConfig(config: StoredAiConfig): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const target = aiConfigPath();
  fs.writeFileSync(target, JSON.stringify(config), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
}

// The dev server can swap the renderer frame mid-load; run the script again once
// it settles instead of failing the IPC call.
async function rendererEval<T>(
  window: BrowserWindow,
  code: string,
): Promise<T> {
  try {
    return (await window.webContents.executeJavaScript(code)) as T;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (
      !message.includes('WebFrame was removed') &&
      !message.includes('Render frame was disposed')
    ) {
      throw error;
    }
    if (window.isDestroyed() || window.webContents.isDestroyed()) throw error;
    if (window.webContents.isLoading()) {
      await new Promise<void>((resolve) =>
        window.webContents.once('did-stop-loading', () => resolve()),
      );
    } else {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    return (await window.webContents.executeJavaScript(code)) as T;
  }
}

// IndexedDB lives in the renderer, so migration state is owned by db/indexeddb.ts.
async function migrateStoreIfNeeded(window: BrowserWindow): Promise<void> {
  const jsonPath = storePath();
  if (!fs.existsSync(jsonPath)) return;
  const done = await rendererEval<boolean>(
    window,
    'window.liltDb.isMigrationDone()',
  );
  if (done) return;

  const parsed = JSON.parse(
    await fs.promises.readFile(jsonPath, 'utf8'),
  ) as Store;
  await rendererEval<void>(
    window,
    `window.liltDb.migrateFromJson(${JSON.stringify(parsed)})`,
  );

  const backupPath = `${jsonPath}.migrated-backup`;
  await fs.promises.copyFile(jsonPath, backupPath);
  await fs.promises.chmod(backupPath, 0o600).catch(() => {});
}

/** store.json is only written when an IndexedDB save fails, so it wins when newer. */
async function newerJsonStore(idbSavedAt: string): Promise<Store | null> {
  try {
    const stat = await fs.promises.stat(storePath());
    if (!(stat.mtimeMs > Date.parse(idbSavedAt))) return null;
    const parsed = JSON.parse(
      await fs.promises.readFile(storePath(), 'utf8'),
    ) as Store & { fallbackSavedAt?: string };
    // Only writes from a failed save carry this marker.
    if (
      !isStore(parsed) ||
      !shouldImportFallback(stat.mtimeMs, idbSavedAt, parsed.fallbackSavedAt)
    ) {
      return null;
    }
    delete parsed.fallbackSavedAt;
    return parsed;
  } catch {
    return null;
  }
}

async function apiKey(): Promise<string> {
  if (memoryKey) return memoryKey;
  const config = readAiConfig();
  if (!config.keyEncrypted) return '';
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return '';
    const { result } = await safeStorage.decryptStringAsync(
      Buffer.from(config.keyEncrypted, 'base64'),
    );
    return result;
  } catch {
    return '';
  }
}

async function aiStatus(): Promise<AiConfig> {
  const config = readAiConfig();
  const key = await apiKey();
  const local = localSttSource(config.sttSource);
  return {
    // shortcut: one flag covers chat + STT, so a Whisper-only local server
    // looks configured and its chat calls fail. Split when that matters.
    configured: key.length > 0 || isLocalEndpoint(config.baseUrl),
    sttSource: config.sttSource,
    sttReady:
      config.sttSource === 'local-server'
        ? config.sttServerUrl.trim().length > 0
        : local
          ? localModelReady(dataDir(), local)
          : key.length > 0 || isLocalEndpoint(config.baseUrl),
    localModels: (Object.keys(LOCAL_STT_MODELS) as LocalSttSource[]).map(
      (id) => ({ id, ready: localModelReady(dataDir(), id) }),
    ),
    baseUrl: config.baseUrl,
    sttServerUrl: config.sttServerUrl,
    chatModel: config.chatModel,
    thinkingModel: config.thinkingModel,
    sttModel: config.sttModel,
    sttLanguage: config.sttLanguage,
    keyStored:
      Boolean(config.keyEncrypted) &&
      (await safeStorage.isAsyncEncryptionAvailable()),
  };
}

function endpoint(config: StoredAiConfig, suffix: string): string {
  return config.baseUrl.replace(/\/+$/, '') + suffix;
}

async function postJson(
  url: string,
  key: string,
  body: unknown,
): Promise<{ status: number; text: string }> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (key) headers.Authorization = `Bearer ${key}`;
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(90_000),
  });
  return { status: response.status, text: await response.text() };
}

async function complete(req: AiCompleteRequest): Promise<{ text: string }> {
  const config = readAiConfig();
  const key = await apiKey();
  if (!key && !isLocalEndpoint(config.baseUrl))
    throw new Error(
      'No API key configured. Add one in Settings → Intelligence.',
    );
  const model =
    req.model === 'auto'
      ? config.chatModel
      : req.model === 'thinking'
        ? config.thinkingModel
        : req.model;
  const payload: Record<string, unknown> = {
    model,
    messages: req.messages,
    temperature: 0.2,
  };
  if (req.json) payload.response_format = { type: 'json_object' };

  let result = await postJson(
    endpoint(config, '/chat/completions'),
    key,
    payload,
  );
  if (result.status === 400 && req.json) {
    delete payload.response_format;
    result = await postJson(
      endpoint(config, '/chat/completions'),
      key,
      payload,
    );
  }
  if (result.status < 200 || result.status >= 300) {
    throw new Error(
      `AI request failed (${result.status}): ${result.text.slice(0, 400)}`,
    );
  }
  const parsed = JSON.parse(result.text) as {
    choices?: { message?: { content?: string } }[];
  };
  const text = parsed.choices?.[0]?.message?.content;
  if (!text) throw new Error('AI returned an empty response');
  return { text };
}

async function transcribe(req: TranscribeRequest): Promise<{ text: string }> {
  const config = readAiConfig();
  if (config.sttSource === 'local-server') {
    if (!config.sttServerUrl.trim())
      throw new Error(
        'Set the local Whisper server URL in Settings → Intelligence.',
      );
    if (!req.pcm || req.pcm.length === 0)
      throw new Error('Local transcription needs audio samples.');
    return {
      text: await localServerTranscribe(
        config.sttServerUrl,
        req.pcm,
        req.language,
        req.prompt,
        config.sttModel,
      ),
    };
  }
  const local = localSttSource(config.sttSource);
  if (local) {
    if (!localModelReady(dataDir(), local))
      throw new Error(
        'The local Whisper model is not downloaded. Open Settings → Intelligence and download it.',
      );
    if (!req.pcm || req.pcm.length === 0)
      throw new Error('Local transcription needs audio samples.');
    return {
      text: await localTranscribe(
        dataDir(),
        local,
        req.pcm,
        req.language,
        req.prompt,
      ),
    };
  }
  const key = await apiKey();
  if (!key && !isLocalEndpoint(config.baseUrl))
    throw new Error(
      'No API key configured. Add one in Settings → Intelligence.',
    );
  if (!req.data || req.data.byteLength > 24 * 1024 * 1024) {
    throw new Error(
      req.data ? 'Audio chunk is too large' : 'No audio chunk was sent',
    );
  }
  const form = new FormData();
  form.append(
    'file',
    new Blob([req.data], { type: req.mime || 'audio/webm' }),
    'meeting-chunk.webm',
  );
  form.append('model', config.sttModel);
  form.append('response_format', 'json');
  // Auto-detect for mixed-language / code-switching (Arabic + English, etc.).
  // Whisper-large-v3-turbo detects well; forcing a language breaks mixed speech.
  if (req.prompt) form.append('prompt', req.prompt);
  const response = await fetch(endpoint(config, '/audio/transcriptions'), {
    method: 'POST',
    headers: key ? { Authorization: `Bearer ${key}` } : {},
    body: form,
    signal: AbortSignal.timeout(60_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(
      `Transcription failed (${response.status}): ${text.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(text) as { text?: string };
  return { text: (parsed.text ?? '').trim() };
}

// ---------------------------------------------------------------------------
// Calendar (read-only OAuth sync; tokens never reach the renderer)
// ---------------------------------------------------------------------------

type CalendarProvider = 'google' | 'microsoft';

interface CalendarRecord {
  provider: CalendarProvider;
  clientId: string;
  clientSecretEncrypted?: string;
  refreshTokenEncrypted?: string;
  email: string;
  name: string;
  connectedAt: string;
  lastSyncedAt: string | null;
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

const OAUTH = {
  google: {
    authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
    token: 'https://oauth2.googleapis.com/token',
    scope:
      'openid email profile https://www.googleapis.com/auth/calendar.readonly',
    redirectHost: '127.0.0.1',
    extra: { access_type: 'offline', prompt: 'consent' },
  },
  microsoft: {
    authorize: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    token: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    scope: 'openid profile email offline_access User.Read Calendars.Read',
    redirectHost: 'localhost',
    extra: {},
  },
} as const;

const calendarPath = () => path.join(dataDir(), 'calendar.json');

let calendarError: string | null = null;
let calendarTokenCache: { token: string; expiresAt: number } | null = null;
let calendarEventsCache: { at: number; events: CalendarEvent[] } | null = null;

function readCalendar(): CalendarRecord | null {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(calendarPath(), 'utf8'),
    ) as CalendarRecord;
    return parsed?.provider ? parsed : null;
  } catch {
    return null;
  }
}

function writeCalendar(record: CalendarRecord): void {
  const target = calendarPath();
  fs.writeFileSync(target, JSON.stringify(record), {
    encoding: 'utf8',
    mode: 0o600,
  });
  try {
    fs.chmodSync(target, 0o600);
  } catch {
    // Windows ignores POSIX modes.
  }
}

async function encryptSecret(value: string): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error(
      'The OS keychain is unavailable, so calendar access cannot be stored safely.',
    );
  }
  return (await safeStorage.encryptStringAsync(value)).toString('base64');
}

async function decryptSecret(value?: string): Promise<string> {
  if (!value) return '';
  try {
    if (!(await safeStorage.isAsyncEncryptionAvailable())) return '';
    const { result } = await safeStorage.decryptStringAsync(
      Buffer.from(value, 'base64'),
    );
    return result;
  } catch {
    return '';
  }
}

async function calendarStatus(): Promise<CalendarStatus> {
  const record = readCalendar();
  return {
    connected: Boolean(
      record?.refreshTokenEncrypted &&
      (await decryptSecret(record.refreshTokenEncrypted)),
    ),
    provider: record?.provider ?? null,
    email: record?.email ?? '',
    name: record?.name ?? '',
    lastSyncedAt: record?.lastSyncedAt ?? null,
    error: calendarError,
  };
}

function base64url(buffer: Buffer): string {
  return buffer
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

async function tokenRequest(
  provider: CalendarProvider,
  body: URLSearchParams,
): Promise<TokenResponse> {
  const response = await fetch(OAUTH[provider].token, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  let data: TokenResponse;
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    throw new Error(`Sign-in failed (${response.status})`);
  }
  if (!response.ok || data.error || !data.access_token) {
    throw new Error(
      data.error_description ??
        data.error ??
        `Sign-in failed (${response.status})`,
    );
  }
  return data;
}

function consentPage(message: string): string {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
<title>Lilt calendar</title>
<body style="font:16px ui-sans-serif,system-ui,sans-serif;padding:56px;background:#f6f2ea;color:#232019">
<h1 style="font-size:22px">${escapeHtml(message)}</h1>
<p style="color:#7d7569">You can close this tab and return to Lilt.</p>
</body></html>`;
}

function waitForCode(
  server: http.Server,
  state: string,
  provider: CalendarProvider,
): Promise<string> {
  return new Promise((resolve, reject) => {
    let timer: NodeJS.Timeout | undefined;
    const finish = (error: Error | null, code?: string) => {
      if (timer) clearTimeout(timer);
      server.close();
      if (error || !code) reject(error ?? new Error('Sign-in failed.'));
      else resolve(code);
    };
    timer = setTimeout(
      () => finish(new Error('Sign-in timed out. Try again.')),
      180_000,
    );
    server.on('request', (req, res) => {
      const remote = req.socket.remoteAddress;
      if (
        remote !== '127.0.0.1' &&
        remote !== '::1' &&
        remote !== '::ffff:127.0.0.1'
      ) {
        res.writeHead(403, { 'Content-Type': 'text/plain' });
        res.end('Forbidden');
        return;
      }
      const url = new URL(
        req.url ?? '/',
        `http://${OAUTH[provider].redirectHost}`,
      );
      if (url.pathname !== '/oauth/callback') {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const failure = url.searchParams.get('error');
      const code = url.searchParams.get('code');
      if (failure) {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(consentPage('Calendar sign-in was cancelled.'));
        finish(new Error(failure));
        return;
      }
      if (url.searchParams.get('state') !== state || !code) {
        res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(consentPage('That sign-in response was not valid.'));
        finish(new Error('Sign-in response could not be verified.'));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(consentPage('Lilt can now read your calendar.'));
      finish(null, code);
    });
    server.on('error', (error) =>
      finish(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

async function fetchProfile(
  provider: CalendarProvider,
  token: string,
): Promise<{ email: string; name: string }> {
  const url =
    provider === 'google'
      ? 'https://openidconnect.googleapis.com/v1/userinfo'
      : 'https://graph.microsoft.com/v1.0/me?$select=displayName,mail,userPrincipalName';
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) {
    throw new Error(`Could not read your profile (${response.status}).`);
  }
  const data = (await response.json()) as {
    email?: string;
    name?: string;
    displayName?: string;
    mail?: string;
    userPrincipalName?: string;
  };
  const email = data.email ?? data.mail ?? data.userPrincipalName ?? '';
  return {
    email,
    name: data.name ?? data.displayName ?? email.split('@')[0] ?? 'Calendar',
  };
}

async function connectCalendar(req: CalendarConnectRequest): Promise<void> {
  const provider: CalendarProvider =
    req.provider === 'microsoft' ? 'microsoft' : 'google';
  const clientId = req.clientId.trim();
  const clientSecret = (req.clientSecret ?? '').trim();
  if (!clientId) throw new Error('Add the OAuth client ID first.');
  if (provider === 'google' && !clientSecret) {
    throw new Error(
      'Google needs the client secret from the same OAuth client.',
    );
  }

  const verifier = base64url(crypto.randomBytes(32));
  const challenge = base64url(
    crypto.createHash('sha256').update(verifier).digest(),
  );
  const state = base64url(crypto.randomBytes(16));
  const server = http.createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // No host: dual-stack, so "localhost" resolves over IPv4 or IPv6.
    server.listen(0, () => resolve());
  });
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  if (!port) {
    server.close();
    throw new Error('Could not open a local sign-in port.');
  }

  const redirectUri = `http://${OAUTH[provider].redirectHost}:${port}/oauth/callback`;
  const authorize = new URL(OAUTH[provider].authorize);
  authorize.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: 'code',
    scope: OAUTH[provider].scope,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    ...OAUTH[provider].extra,
  }).toString();

  const waiting = waitForCode(server, state, provider);
  try {
    await shell.openExternal(authorize.toString());
  } catch {
    server.close();
    void waiting.catch(() => {});
    throw new Error('Could not open the browser for calendar sign-in.');
  }
  const code = await waiting;

  const body = new URLSearchParams({
    client_id: clientId,
    grant_type: 'authorization_code',
    code,
    redirect_uri: redirectUri,
    code_verifier: verifier,
  });
  if (provider === 'google') body.set('client_secret', clientSecret);
  else body.set('scope', OAUTH[provider].scope);
  const tokens = await tokenRequest(provider, body);
  if (!tokens.refresh_token) {
    throw new Error(
      'The provider did not return a refresh token. Remove Lilt from your account permissions, then connect again.',
    );
  }

  const profile = await fetchProfile(provider, tokens.access_token!);
  const record: CalendarRecord = {
    provider,
    clientId,
    clientSecretEncrypted: clientSecret
      ? await encryptSecret(clientSecret)
      : undefined,
    refreshTokenEncrypted: await encryptSecret(tokens.refresh_token),
    email: profile.email,
    name: profile.name,
    connectedAt: new Date().toISOString(),
    lastSyncedAt: null,
  };
  writeCalendar(record);
  calendarTokenCache = {
    token: tokens.access_token!,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  calendarEventsCache = null;
  calendarError = null;
}

async function calendarToken(record: CalendarRecord): Promise<string> {
  if (
    calendarTokenCache &&
    calendarTokenCache.expiresAt > Date.now() + 60_000
  ) {
    return calendarTokenCache.token;
  }
  const refresh = await decryptSecret(record.refreshTokenEncrypted);
  if (!refresh) {
    throw new Error('Calendar access expired. Reconnect in Settings.');
  }
  const body = new URLSearchParams({
    client_id: record.clientId,
    grant_type: 'refresh_token',
    refresh_token: refresh,
  });
  if (record.provider === 'google') {
    const secret = await decryptSecret(record.clientSecretEncrypted);
    if (secret) body.set('client_secret', secret);
  } else {
    body.set('scope', OAUTH.microsoft.scope);
  }
  const tokens = await tokenRequest(record.provider, body);
  calendarTokenCache = {
    token: tokens.access_token!,
    expiresAt: Date.now() + (tokens.expires_in ?? 3600) * 1000,
  };
  return tokens.access_token!;
}

// shortcut: integration-test surface — calendar + STT + chunk queue; see docs/adrs/integration-tests.md
async function fetchCalendarEvents(): Promise<CalendarEvent[]> {
  const record = readCalendar();
  if (!record) return [];
  if (calendarEventsCache && Date.now() - calendarEventsCache.at < 60_000) {
    return calendarEventsCache.events;
  }
  try {
    const token = await calendarToken(record);
    const now = Date.now();
    const from = new Date(now - 3_600_000).toISOString();
    const to = new Date(now + 14 * 86_400_000).toISOString();
    const headers = { Authorization: `Bearer ${token}` };
    let events: CalendarEvent[];

    if (record.provider === 'google') {
      const url = new URL(
        'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      );
      url.search = new URLSearchParams({
        singleEvents: 'true',
        orderBy: 'startTime',
        maxResults: '100',
        timeMin: from,
        timeMax: to,
      }).toString();
      const response = await fetch(url, {
        headers,
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'Calendar access expired. Reconnect in Settings.'
            : `Calendar sync failed (${response.status}).`,
        );
      }
      events = mapGoogleEvents(await response.json());
    } else {
      const url = new URL('https://graph.microsoft.com/v1.0/me/calendarView');
      url.search = new URLSearchParams({
        startDateTime: from,
        endDateTime: to,
        $select:
          'subject,start,end,attendees,onlineMeeting,bodyPreview,isAllDay,isCancelled',
        $orderby: 'start/dateTime',
        $top: '100',
      }).toString();
      const response = await fetch(url, {
        headers: { ...headers, Prefer: 'outlook.timezone="UTC"' },
        signal: AbortSignal.timeout(30_000),
      });
      if (!response.ok) {
        throw new Error(
          response.status === 401
            ? 'Calendar access expired. Reconnect in Settings.'
            : `Calendar sync failed (${response.status}).`,
        );
      }
      events = mapMicrosoftEvents(await response.json());
    }

    record.lastSyncedAt = new Date().toISOString();
    writeCalendar(record);
    calendarEventsCache = { at: Date.now(), events };
    calendarError = null;
    return events;
  } catch (error) {
    calendarError =
      error instanceof Error ? error.message : 'Calendar sync failed.';
    calendarEventsCache = null;
    throw new Error(calendarError);
  }
}

async function disconnectCalendar(): Promise<CalendarStatus> {
  try {
    fs.rmSync(calendarPath(), { force: true });
  } catch {
    console.error('Could not remove calendar credentials');
  }
  calendarTokenCache = null;
  calendarEventsCache = null;
  calendarError = null;
  return calendarStatus();
}

function sharePage(shared: ReturnType<typeof sanitizeSharedNote>): string {
  const date = new Date(shared.createdAt).toLocaleDateString('en', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    year: 'numeric',
  });
  const sections = shared.sections
    .filter((section) => section.bullets.length > 0)
    .map(
      (section) => `
      <section>
        <h2>${escapeHtml(section.heading)}</h2>
        <ul>${section.bullets.map((bullet) => `<li>${escapeHtml(bullet)}</li>`).join('')}</ul>
      </section>`,
    )
    .join('');
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(shared.title)} · ${escapeHtml(shared.workspaceName)}</title>
<style>
:root{--paper:#f7f4ee;--surface:#fffdfa;--ink:#24211e;--muted:#7c756b;--line:rgba(36,33,30,.12);--green:#3f6b52}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,'Segoe UI',sans-serif}
main{max-width:720px;margin:0 auto;padding:56px 28px 80px}
.badge{display:inline-flex;align-items:center;gap:8px;font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--green);font-weight:600}
.dot{width:7px;height:7px;border-radius:50%;background:var(--green)}
h1{font-family:'C059','Liberation Serif',Georgia,serif;font-weight:600;font-size:42px;line-height:1.12;letter-spacing:-.02em;margin:18px 0 10px}
.meta{color:var(--muted);font-size:14px;margin-bottom:34px}
.card{background:var(--surface);border:1px solid var(--line);border-radius:16px;padding:8px 30px 30px;box-shadow:0 1px 2px rgba(36,33,30,.04)}
h2{font-family:'C059','Liberation Serif',Georgia,serif;font-weight:600;font-size:20px;margin:26px 0 8px}
ul{margin:0;padding-left:20px}li{margin:7px 0;color:#3b3631}
footer{margin-top:26px;padding-top:18px;border-top:1px solid var(--line);color:var(--muted);font-size:13px}
.attendees{display:flex;flex-wrap:wrap;gap:6px;margin-top:10px}
.pill{background:#ece7dd;border-radius:999px;padding:3px 10px;font-size:12px;color:#5e574e}
@media(max-width:560px){h1{font-size:32px}main{padding:32px 18px}.card{padding:4px 20px 22px}}
</style></head>
<body><main>
  <span class="badge"><span class="dot"></span>Local preview · ${escapeHtml(shared.workspaceName)}</span>
  <h1>${escapeHtml(shared.title)}</h1>
  <div class="meta">${escapeHtml(date)}</div>
  ${shared.attendees.length ? `<div class="attendees">${shared.attendees.map((person) => `<span class="pill">${escapeHtml(person)}</span>`).join('')}</div>` : ''}
  <div class="card">
    ${shared.hasSummary ? sections : '<p style="color:var(--muted);padding:18px 0">The summary for this meeting is still being written.</p>'}
    <footer>The transcript and raw notes stay with the note owner. This page is served only on their computer.</footer>
  </div>
</main></body></html>`;
}

function noticePage(title: string, message: string): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${escapeHtml(title)}</title>
<style>
body{margin:0;background:#f7f4ee;color:#24211e;font:16px/1.6 ui-sans-serif,system-ui,-apple-system,sans-serif;display:grid;place-items:center;min-height:100vh}
main{max-width:420px;padding:36px;background:#fffdfa;border:1px solid rgba(36,33,30,.12);border-radius:16px;margin:20px}
h1{font-family:'C059','Liberation Serif',Georgia,serif;font-size:28px;margin:0 0 8px}
p{color:#7c756b;font-size:14px}
</style></head>
<body><main>
  <h1>${escapeHtml(title)}</h1>
  <p>${escapeHtml(message)}</p>
</main></body></html>`;
}

async function handleShare(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const match = /^\/s\/([A-Za-z0-9-]+)$/.exec(url.pathname);
  const send = (
    status: number,
    body: string,
    headers: Record<string, string> = {},
  ) => {
    res.writeHead(status, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy':
        "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; base-uri 'none'; frame-ancestors 'none'",
      ...headers,
    });
    res.end(body);
  };
  if (!match) {
    send(
      404,
      noticePage('Not found', 'That link does not point to a shared note.'),
    );
    return;
  }
  const note = sharedNoteFor(storeCache.notes, match[1]);
  if (!note) {
    send(
      404,
      noticePage(
        'Private link',
        'This link is private, revoked, or does not exist.',
      ),
    );
    return;
  }
  send(200, sharePage(sanitizeSharedNote(note, storeCache.workspace)));
}

function startShareServer(): void {
  shareServer = http.createServer((req, res) => {
    void handleShare(req, res).catch((error) => {
      console.error('Share server error', error);
      res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Something went wrong');
    });
  });
  shareServer.listen(0, '127.0.0.1', () => {
    const address = shareServer?.address();
    sharePort = typeof address === 'object' && address ? address.port : 0;
  });
}

function registerIpc(): void {
  ipcMain.handle('store:load', async () => {
    // Proxy to renderer which owns IndexedDB
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        await migrateStoreIfNeeded(window);
        // A newer store.json means the last save could only reach the JSON
        // fallback (frame disposed, app quitting). Import it instead of losing it.
        const idbSavedAt = await rendererEval<string>(
          window,
          'window.liltDb.lastSavedAt()',
        );
        const fallback = await newerJsonStore(idbSavedAt);
        if (fallback) {
          await rendererEval<void>(
            window,
            `window.liltDb.saveStore(${JSON.stringify(fallback)})`,
          );
          storeCache = fallback;
          return fallback;
        }
        const loaded = await rendererEval<Store>(
          window,
          'window.liltDb.loadStore()',
        );
        storeCache = loaded;
        return loaded;
      } catch (error) {
        console.error('Renderer load failed:', error);
      }
    }
    // Fallback to memory cache
    return storeCache;
  });

  ipcMain.handle('store:save', async (_event, next: Store) => {
    if (!isStore(next)) throw new Error('Refusing to save an invalid store');
    // Proxy to renderer
    for (const window of BrowserWindow.getAllWindows()) {
      try {
        await rendererEval<void>(
          window,
          `window.liltDb.saveStore(${JSON.stringify(next)})`,
        );
        storeCache = next;
        return { savedAt: new Date().toISOString() };
      } catch (error) {
        console.error('Renderer save failed:', error);
      }
    }
    return { savedAt: await writeStore(next, true) };
  });

  ipcMain.handle('ai:config', () => aiStatus());
  ipcMain.handle(
    'ai:set-config',
    async (
      _event,
      next: {
        baseUrl: string;
        sttServerUrl: string;
        chatModel: string;
        thinkingModel: string;
        sttModel: string;
        sttLanguage: string;
        sttSource: SttSource;
        apiKey?: string;
      },
    ) => {
      const config = readAiConfig();
      config.baseUrl = next.baseUrl.trim() || DEFAULT_AI.baseUrl;
      config.sttServerUrl = next.sttServerUrl.trim() || DEFAULT_AI.sttServerUrl;
      config.chatModel = next.chatModel.trim() || DEFAULT_AI.chatModel;
      config.thinkingModel =
        next.thinkingModel.trim() || DEFAULT_AI.thinkingModel;
      config.sttModel = next.sttModel.trim() || DEFAULT_AI.sttModel;
      config.sttLanguage = next.sttLanguage.trim() || DEFAULT_AI.sttLanguage;
      if (
        next.sttSource === 'cloud' ||
        next.sttSource === 'local-server' ||
        localSttSource(next.sttSource) !== null
      ) {
        config.sttSource = next.sttSource;
      }
      if (typeof next.apiKey === 'string') {
        if (next.apiKey.length === 0) {
          delete config.keyEncrypted;
          memoryKey = '';
        } else if (await safeStorage.isAsyncEncryptionAvailable()) {
          config.keyEncrypted = (
            await safeStorage.encryptStringAsync(next.apiKey)
          ).toString('base64');
          memoryKey = '';
        } else {
          memoryKey = next.apiKey;
          delete config.keyEncrypted;
        }
      }
      writeAiConfig(config);
      return aiStatus();
    },
  );

  ipcMain.handle('ai:complete', (_event, req: AiCompleteRequest) =>
    complete(req),
  );
  ipcMain.handle('ai:transcribe', (_event, req: TranscribeRequest) =>
    transcribe(req),
  );
  ipcMain.handle('stt:download', async (event, requested: SttSource) => {
    const source = localSttSource(requested);
    if (!source)
      throw new Error('Choose a local Whisper model in Settings first.');
    await downloadLocalModel(dataDir(), source, (progress) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send('stt:progress', progress);
      }
    });
    return aiStatus();
  });

  ipcMain.handle('calendar:status', () => calendarStatus());
  ipcMain.handle(
    'calendar:connect',
    async (_event, req: CalendarConnectRequest) => {
      await connectCalendar(req);
      const status = await calendarStatus();
      if (status.connected) {
        for (const window of BrowserWindow.getAllWindows()) {
          window.webContents.send('calendar:status-changed', true);
        }
      }
      return status;
    },
  );
  ipcMain.handle('calendar:disconnect', async () => {
    const status = await disconnectCalendar();
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('calendar:status-changed', false);
    }
    return status;
  });
  ipcMain.handle('calendar:events', () => fetchCalendarEvents());

  ipcMain.handle('share:url', (_event, token: string) => {
    if (!sharePort) throw new Error('Share server is not ready');
    return `http://127.0.0.1:${sharePort}/s/${encodeURIComponent(token)}`;
  });
  ipcMain.handle('share:open', async (_event, token: string) => {
    if (!sharePort) throw new Error('Share server is not ready');
    await shell.openExternal(
      `http://127.0.0.1:${sharePort}/s/${encodeURIComponent(token)}`,
    );
  });

  ipcMain.handle('meeting:set-enabled', (_event, enabled: boolean) => {
    setMeetingDetection(Boolean(enabled));
  });

  registerAudioRetentionIpc();
}

let meetingPollingCleanup: (() => void) | null = null;

function setMeetingDetection(enabled: boolean): void {
  if (!enabled) {
    meetingPollingCleanup?.();
    meetingPollingCleanup = null;
    return;
  }
  if (meetingPollingCleanup) return;
  meetingPollingCleanup = startMeetingPolling(fetchCalendarEvents, (event) => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('meeting:detected', event);
    }
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 1060,
    minHeight: 680,
    backgroundColor: '#f7f4ee',
    title: 'Lilt',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      void shell.openExternal(url);
    }
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    const allowed = isDev && url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL);
    if (!allowed) {
      event.preventDefault();
      if (url.startsWith('https://')) void shell.openExternal(url);
    }
  });

  if (isDev) {
    window.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    window.loadFile(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`),
    );
  }
}

app.whenReady().then(async () => {
  if (!hasLock) return;
  fs.mkdirSync(dataDir(), { recursive: true });

  // Cache the JSON store for main-process handlers until the renderer loads
  // IndexedDB through store:load.
  try {
    storeCache = await readStore();
  } catch (error) {
    dialog.showErrorBox(
      'Lilt could not open your notes',
      error instanceof Error ? error.message : 'The notes file is unreadable.',
    );
    app.quit();
    return;
  }
  registerIpc();
  startShareServer();
  for (const file of [aiConfigPath(), calendarPath()]) {
    try {
      fs.chmodSync(file, 0o600);
    } catch {
      // Missing file or Windows: nothing to tighten.
    }
  }

  session.defaultSession.setDisplayMediaRequestHandler(
    (_request, callback) => {
      desktopCapturer
        .getSources({
          types: ['screen'],
          thumbnailSize: { width: 0, height: 0 },
        })
        .then(async (sources) => {
          if (!sources[0]) return callback({});
          let source = sources[0];
          if (sources.length > 1) {
            const { response } = await dialog.showMessageBox({
              type: 'question',
              buttons: [...sources.map((entry) => entry.name), 'Cancel'],
              cancelId: sources.length,
              defaultId: 0,
              message: 'Which screen should Lilt listen to?',
              detail:
                'Only system audio is used. The screen video is discarded immediately.',
            });
            if (response < 0 || response >= sources.length) {
              return callback({});
            }
            source = sources[response] ?? sources[0];
          }
          callback({ video: source, audio: 'loopback' });
        })
        .catch(() => callback({}));
    },
    { useSystemPicker: false },
  );

  createWindow();

  powerMonitor.on('suspend', () => {
    for (const window of BrowserWindow.getAllWindows()) {
      window.webContents.send('power:suspend');
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  stopLocalServer();
  shareServer?.close();
});
