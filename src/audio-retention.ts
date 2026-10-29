import { app, ipcMain } from 'electron';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isPendingChunkPath,
  PENDING_FILE_PREFIX,
} from './shared/pending-path.ts';

const TEMP_DIR = path.join(app.getPath('temp'), 'lilt-chunks');
const PENDING_FILE_EXT = '.webm';

export interface PendingChunk {
  noteId: string;
  source: 'mic' | 'system';
  filePath: string;
  startMs: number;
  endMs: number;
  speechStartMs: number;
  speechEndMs: number;
  baseMs: number;
  language: string;
  prompt?: string;
  attempts: number;
  createdAt: string;
}

function ensureTempDir(): void {
  fs.mkdirSync(TEMP_DIR, { recursive: true });
}

function metaPathFor(filePath: string): string {
  return filePath.replace(PENDING_FILE_EXT, '.json');
}

function writePendingChunk(
  noteId: string,
  source: 'mic' | 'system',
  buffer: Buffer,
  startMs: number,
  endMs: number,
  speechStartMs: number,
  speechEndMs: number,
  baseMs: number,
  language: string,
  prompt?: string,
): string {
  ensureTempDir();
  const fileName = `${PENDING_FILE_PREFIX}${crypto.randomUUID()}-${source}${PENDING_FILE_EXT}`;
  const filePath = path.join(TEMP_DIR, fileName);

  fs.writeFileSync(filePath, buffer);

  const meta: PendingChunk = {
    noteId,
    source,
    filePath,
    startMs,
    endMs,
    speechStartMs,
    speechEndMs,
    baseMs,
    language,
    prompt,
    attempts: 0,
    createdAt: new Date().toISOString(),
  };

  fs.writeFileSync(metaPathFor(filePath), JSON.stringify(meta));

  return filePath;
}

async function readPendingChunks(): Promise<PendingChunk[]> {
  ensureTempDir();
  const files = await fs.promises.readdir(TEMP_DIR);
  const chunks: PendingChunk[] = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const metaPath = path.join(TEMP_DIR, file);
    try {
      const content = await fs.promises.readFile(metaPath, 'utf8');
      const meta = JSON.parse(content) as PendingChunk;
      if (!isPendingChunkPath(TEMP_DIR, meta.filePath)) {
        await fs.promises.unlink(metaPath);
        continue;
      }
      try {
        await fs.promises.access(meta.filePath);
        chunks.push(meta);
      } catch {
        await fs.promises.unlink(metaPath);
      }
    } catch (error) {
      console.error('Failed to read pending chunk meta:', error);
    }
  }

  return chunks.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

async function deletePendingChunk(filePath: string): Promise<void> {
  try {
    await fs.promises.rm(filePath, { force: true });
    await fs.promises.rm(metaPathFor(filePath), { force: true });
  } catch (error) {
    console.error('Failed to delete pending chunk:', error);
  }
}

async function incrementAttempts(filePath: string): Promise<void> {
  const metaPath = metaPathFor(filePath);
  try {
    const content = await fs.promises.readFile(metaPath, 'utf8');
    const meta = JSON.parse(content) as PendingChunk;
    meta.attempts += 1;
    await fs.promises.writeFile(metaPath, JSON.stringify(meta));
  } catch (error) {
    console.error('Failed to increment attempts:', error);
  }
}

async function readChunkFile(filePath: string): Promise<ArrayBuffer> {
  const buffer = await fs.promises.readFile(filePath);
  return buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength,
  ) as ArrayBuffer;
}

function assertPendingPath(filePath: string): void {
  if (!isPendingChunkPath(TEMP_DIR, filePath)) {
    throw new Error('Invalid chunk path');
  }
}

export function registerAudioRetentionIpc(): void {
  ipcMain.handle(
    'audio-retention:write',
    async (
      _event,
      data: {
        noteId: string;
        source: 'mic' | 'system';
        arrayBuffer: ArrayBuffer;
        startMs: number;
        endMs: number;
        speechStartMs: number;
        speechEndMs: number;
        baseMs: number;
        language: string;
        prompt?: string;
      },
    ) => {
      return writePendingChunk(
        data.noteId,
        data.source,
        Buffer.from(data.arrayBuffer),
        data.startMs,
        data.endMs,
        data.speechStartMs,
        data.speechEndMs,
        data.baseMs,
        data.language,
        data.prompt,
      );
    },
  );

  ipcMain.handle('audio-retention:read-pending', () => readPendingChunks());

  ipcMain.handle(
    'audio-retention:read-chunk',
    async (_event, filePath: string) => {
      assertPendingPath(filePath);
      return readChunkFile(filePath);
    },
  );

  ipcMain.handle('audio-retention:delete', async (_event, filePath: string) => {
    assertPendingPath(filePath);
    await deletePendingChunk(filePath);
  });

  ipcMain.handle(
    'audio-retention:increment-attempts',
    async (_event, filePath: string) => {
      assertPendingPath(filePath);
      await incrementAttempts(filePath);
    },
  );
}
