import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { app } from 'electron';
import { STREAM_STT_MODEL } from './shared/logic.ts';
import type {
  SpeakerSource,
  StreamTextEvent,
  SttProgress,
} from './shared/types.ts';
import { downloadModel } from './local-stt.ts';

/** Built by `npm run build:transcribe` into vendor/, shipped in resources/. */
function binaryPath(): string {
  const root = app.isPackaged
    ? process.resourcesPath
    : path.join(app.getAppPath(), 'vendor');
  return path.join(
    root,
    'transcribe',
    `${process.platform}-${process.arch}`,
    process.platform === 'win32'
      ? 'transcribe-stream.exe'
      : 'transcribe-stream',
  );
}

export function streamModelPath(dataDir: string): string {
  return path.join(dataDir, 'models', STREAM_STT_MODEL.file);
}

export function streamModelReady(dataDir: string): boolean {
  return fs.existsSync(streamModelPath(dataDir));
}

export function downloadStreamModel(
  dataDir: string,
  onProgress: (progress: SttProgress) => void,
): Promise<void> {
  return downloadModel(dataDir, STREAM_STT_MODEL, onProgress);
}

interface Live {
  child: ChildProcess;
  /** Partial stdout line, kept between writes. */
  buffer: string;
  /** Set when the app stopped the stream, so its exit is not an error. */
  stopping: boolean;
}

// One helper per audio source: each keeps its own decoder state across chunks,
// which is what makes words appear while the person is still talking.
const streams = new Map<SpeakerSource, Live>();

export function startStream(
  dataDir: string,
  source: SpeakerSource,
  language: string,
  onText: (event: StreamTextEvent) => void,
): void {
  stopStream(source);
  const binary = binaryPath();
  if (!fs.existsSync(binary)) {
    throw new Error(
      'The live transcription engine is missing from this build. Run "npm run build:transcribe -- --force".',
    );
  }
  const model = streamModelPath(dataDir);
  if (!fs.existsSync(model)) {
    throw new Error('The live transcription model is not downloaded.');
  }
  const args = [model];
  if (language && language !== 'auto') args.push('--language', language);
  const child = spawn(binary, args, { stdio: ['pipe', 'pipe', 'pipe'] });
  // A push can land after the engine has exited; without this the EPIPE
  // surfaces as an uncaught error and takes the main process down.
  child.stdin?.on('error', () => undefined);
  const live: Live = { child, buffer: '', stopping: false };
  streams.set(source, live);

  let log = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-500);
  });
  child.stdout?.on('data', (chunk: Buffer) => {
    live.buffer += chunk.toString();
    const lines = live.buffer.split('\n');
    live.buffer = lines.pop() ?? '';
    for (const line of lines) {
      const event = parseEvent(line);
      if (!event) continue;
      onText({ source, ...event });
    }
  });

  const fail = (message: string) => {
    if (streams.get(source) !== live) return;
    streams.delete(source);
    child.kill();
    onText({
      source,
      committed: '',
      tentative: '',
      final: true,
      error: message,
    });
  };
  child.once('error', (error) => fail(error.message));
  child.once('exit', (code) => {
    if (streams.get(source) !== live) return;
    if (!live.stopping && code !== 0) {
      fail(log.trim() || `Live transcription stopped (${code}).`);
      return;
    }
    streams.delete(source);
  });
}

interface StreamLine {
  committed: string;
  tentative: string;
  final: boolean;
}

function parseEvent(line: string): StreamLine | null {
  const text = line.trim();
  if (!text.startsWith('{')) return null;
  try {
    const value = JSON.parse(text) as Partial<StreamLine>;
    return {
      committed: typeof value.committed === 'string' ? value.committed : '',
      tentative: typeof value.tentative === 'string' ? value.tentative : '',
      final: value.final === true,
    };
  } catch {
    return null;
  }
}

/** Close the helper's stdin: it flushes the last words and exits on its own. */
export function stopStream(source: SpeakerSource): void {
  const live = streams.get(source);
  if (!live) return;
  live.stopping = true;
  live.child.stdin?.end();
}

export function pushStream(source: SpeakerSource, pcm: Float32Array): void {
  const live = streams.get(source);
  if (!live) return;
  // shortcut: no backpressure handling. A stalled helper queues a few KB per
  // second in this process; bound it if a long recording ever shows up here.
  const bytes = Buffer.allocUnsafe(pcm.length * 2);
  for (let index = 0; index < pcm.length; index += 1) {
    const sample = Math.max(-1, Math.min(1, pcm[index]));
    bytes.writeInt16LE(Math.round(sample * 32767), index * 2);
  }
  live.child.stdin?.write(bytes);
}

/** Hard stop, used at quit where there is no time to flush. */
export function stopAllStreams(): void {
  for (const live of streams.values()) {
    live.stopping = true;
    live.child.kill();
  }
  streams.clear();
}
