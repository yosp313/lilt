import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { app } from 'electron';
import {
  encodeWav,
  LOCAL_STT_MODELS,
  type LocalSttSource,
} from './shared/logic.ts';
import type { SttProgress } from './shared/types.ts';

/** Built by `npm run build:whisper` into vendor/, shipped in resources/. */
function binaryPath(name: 'whisper-cli' | 'whisper-server'): string {
  const root = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'vendor');
  return path.join(
    root,
    'whisper',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32' ? `${name}.exe` : name,
  );
}

function localModelPath(dataDir: string, source: LocalSttSource): string {
  return path.join(dataDir, 'models', LOCAL_STT_MODELS[source].file);
}

export function localModelReady(
  dataDir: string,
  source: LocalSttSource,
): boolean {
  return fs.existsSync(localModelPath(dataDir, source));
}

export async function downloadLocalModel(
  dataDir: string,
  source: LocalSttSource,
  onProgress: (progress: SttProgress) => void,
): Promise<void> {
  const model = LOCAL_STT_MODELS[source];
  const target = localModelPath(dataDir, source);
  const partial = `${target}.part`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const response = await fetch(model.url);
  if (!response.ok || !response.body) {
    throw new Error(`The model download failed (${response.status}).`);
  }
  const total =
    Number(response.headers.get('content-length')) || model.sizeMb * 1_000_000;
  let received = 0;
  try {
    await pipeline(
      Readable.fromWeb(response.body as never),
      async function* (chunks) {
        for await (const chunk of chunks) {
          received += chunk.length;
          onProgress({
            file: model.label,
            percent: Math.min(99, Math.round((received / total) * 100)),
          });
          yield chunk;
        }
      },
      fs.createWriteStream(partial),
    );
  } catch (error) {
    fs.rmSync(partial, { force: true });
    throw error;
  }
  if (received < total * 0.98) {
    fs.rmSync(partial, { force: true });
    throw new Error('The model download was incomplete. Try again.');
  }
  // A complete file only appears under the real name, so a failed download is
  // never mistaken for a ready model.
  fs.renameSync(partial, target);
  onProgress({ file: model.label, percent: 100 });
}

// One server keeps the model resident; requests queue behind its inference
// mutex, so mic and system chunks never oversubscribe the CPU.
interface Server {
  key: string;
  child: ChildProcess;
  url: string;
}

let server: Server | null = null;
let booting: Promise<Server> | null = null;
let bootingKey = '';
let startingChild: ChildProcess | null = null;

function alive(entry: Server | null): entry is Server {
  return (
    entry !== null &&
    entry.child.exitCode === null &&
    entry.child.signalCode === null
  );
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() => {
        if (typeof address === 'object' && address) resolve(address.port);
        else reject(new Error('Could not reserve a local port.'));
      });
    });
  });
}

async function startServer(key: string, modelPath: string): Promise<Server> {
  const binary = binaryPath('whisper-server');
  if (!fs.existsSync(binary)) {
    throw new Error(
      'whisper-server is missing from this build. Run "npm run build:whisper -- --force".',
    );
  }
  const port = await freePort();
  const threads = Math.max(1, Math.min(8, os.availableParallelism()));
  const child = spawn(
    binary,
    [
      '-m',
      modelPath,
      '--host',
      '127.0.0.1',
      '--port',
      String(port),
      '-t',
      String(threads),
      '-fa',
      '-sns',
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );
  startingChild = child;
  const spawnState: { error: Error | null } = { error: null };
  child.once('error', (error) => {
    spawnState.error = error;
  });
  let log = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-2000);
  });
  const url = `http://127.0.0.1:${port}`;
  const deadline = Date.now() + 60_000;
  try {
    while (Date.now() < deadline) {
      if (spawnState.error) {
        throw new Error(
          `whisper-server could not start: ${spawnState.error.message}`,
        );
      }
      if (child.exitCode !== null) {
        throw new Error(
          `whisper-server exited (${child.exitCode}). ${log.trim()}`,
        );
      }
      try {
        const health = await fetch(`${url}/health`, {
          signal: AbortSignal.timeout(1500),
        });
        if (health.ok) return { key, child, url };
      } catch {
        // Still loading the model.
      }
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    child.kill();
    throw new Error(`whisper-server did not start in time. ${log.trim()}`);
  } finally {
    startingChild = null;
  }
}

async function ensureServer(modelPath: string): Promise<string> {
  const key = `${binaryPath('whisper-server')}\0${modelPath}`;
  if (alive(server) && server.key === key) return server.url;
  if (booting && bootingKey === key) return (await booting).url;
  if (booting) await booting.catch(() => undefined);
  if (alive(server) && server.key === key) return server.url;
  stopLocalServer();
  bootingKey = key;
  booting = startServer(key, modelPath);
  try {
    server = await booting;
    return server.url;
  } finally {
    booting = null;
  }
}

/** Stop the resident server. Called when the app quits. */
export function stopLocalServer(): void {
  startingChild?.kill();
  startingChild = null;
  server?.child.kill();
  server = null;
}

let chunkId = 0;

async function readResult(response: Response): Promise<string> {
  const body = await response.text();
  if (!response.ok) {
    throw new Error(
      `Local transcription failed (${response.status}): ${body.slice(0, 300)}`,
    );
  }
  const parsed = JSON.parse(body) as { text?: string };
  return (parsed.text ?? '').replace(/\s+/g, ' ').trim();
}

async function infer(
  baseUrl: string,
  pcm: Float32Array,
  language: string,
  prompt: string | undefined,
  model: string | undefined,
  allowOpenAi: boolean,
): Promise<string> {
  const url = baseUrl.replace(/\/+$/, '');
  const file = new Blob([encodeWav(pcm)], { type: 'audio/wav' });
  const name = `chunk-${chunkId++}.wav`;
  const form = new FormData();
  form.append('file', file, name);
  form.append('response_format', 'json');
  form.append('language', language && language !== 'auto' ? language : 'auto');
  form.append('temperature', '0');
  form.append('suppress_nst', 'true');
  if (prompt) form.append('prompt', prompt);
  const response = await fetch(`${url}/inference`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(120_000),
  });
  if (!allowOpenAi || response.status !== 404) return readResult(response);
  // Speaches and other OpenAI-compatible servers use the API path instead.
  await response.body?.cancel();
  const fallback = new FormData();
  fallback.append('file', file, name);
  fallback.append('response_format', 'json');
  if (model) fallback.append('model', model);
  if (language && language !== 'auto') fallback.append('language', language);
  fallback.append('temperature', '0');
  if (prompt) fallback.append('prompt', prompt);
  return readResult(
    await fetch(`${url}/audio/transcriptions`, {
      method: 'POST',
      body: fallback,
      signal: AbortSignal.timeout(120_000),
    }),
  );
}

export async function localTranscribe(
  dataDir: string,
  source: LocalSttSource,
  pcm: Float32Array,
  language: string,
  prompt?: string,
): Promise<string> {
  const modelPath = localModelPath(dataDir, source);
  if (!fs.existsSync(modelPath)) {
    throw new Error('The local Whisper model is not downloaded.');
  }
  return infer(
    await ensureServer(modelPath),
    pcm,
    language,
    prompt,
    undefined,
    false,
  );
}

/** A whisper-server or OpenAI-compatible server the user runs themselves. */
export async function localServerTranscribe(
  baseUrl: string,
  pcm: Float32Array,
  language: string,
  prompt: string | undefined,
  model: string,
): Promise<string> {
  return infer(baseUrl, pcm, language, prompt, model, true);
}
