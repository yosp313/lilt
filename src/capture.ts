export type CaptureState = 'recording' | 'paused' | 'stopped';

export interface CaptureHandlers {
  onLevel(me: number, them: number): void;
  onChunk(
    source: 'mic' | 'system',
    blob: Blob,
    startMs: number,
    endMs: number,
  ): void;
  onState(state: CaptureState): void;
  onNotice(message: string): void;
  onAutoStop(reason: string): void;
}

interface SourceLoop {
  source: 'mic' | 'system';
  stream: MediaStream;
  recorder: MediaRecorder | null;
  chunks: Blob[];
  chunkStart: number;
  timer: number | null;
  analyser: AnalyserNode;
  samples: Uint8Array<ArrayBuffer>;
}

const CHUNK_MS = 7000;
// shortcut: fixed 7s HTTP chunks, not streaming partials. A WebSocket STT
// provider (Deepgram/AssemblyAI) or whisper-stream is the upgrade path.
const SILENCE_AFTER_MS = 15 * 60_000;
const LOUD = 0.012;

export class Capture {
  private handlers: CaptureHandlers;
  private loops: SourceLoop[] = [];
  private audioContext: AudioContext | null = null;
  private activeMs = 0;
  private resumedAt = 0;
  private running = false;
  private paused = false;
  private lastLoudAt = 0;
  private levelTimer: number | null = null;
  private silenceTimer: number | null = null;
  private stopping: Promise<void> | null = null;

  constructor(handlers: CaptureHandlers) {
    this.handlers = handlers;
  }

  get elapsedMs(): number {
    if (!this.running) return Math.round(this.activeMs);
    const live = this.paused ? 0 : performance.now() - this.resumedAt;
    return Math.round(this.activeMs + live);
  }

  get isRunning(): boolean {
    return this.running;
  }

  async start(includeSystemAudio: boolean): Promise<void> {
    if (this.running) return;
    this.activeMs = 0;
    this.paused = false;
    this.lastLoudAt = 0;

    let mic: MediaStream;
    try {
      mic = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
    } catch (error) {
      throw new Error(
        'Microphone access was denied. Allow it in your system settings, then try again. ' +
          (error instanceof Error ? error.message : ''),
      );
    }

    let system: MediaStream | null = null;
    if (includeSystemAudio) {
      try {
        system = await navigator.mediaDevices.getDisplayMedia({
          video: true,
          audio: true,
        });
        system.getVideoTracks().forEach((track) => track.stop());
        if (system.getAudioTracks().length === 0) {
          system.getTracks().forEach((track) => track.stop());
          system = null;
          this.handlers.onNotice(
            'System audio was not shared. Recording your microphone only.',
          );
        }
      } catch {
        this.handlers.onNotice(
          'System audio was not shared. Recording your microphone only.',
        );
      }
    }

    this.audioContext = new AudioContext();
    this.addLoop('mic', mic);
    if (system) this.addLoop('system', system);

    this.running = true;
    this.resumedAt = performance.now();
    for (const loop of this.loops) this.startChunk(loop);

    this.levelTimer = window.setInterval(() => this.tickLevels(), 90);
    this.silenceTimer = window.setInterval(() => this.checkSilence(), 5000);
    this.handlers.onState('recording');
  }

  pause(): void {
    if (!this.running || this.paused) return;
    this.paused = true;
    this.activeMs += performance.now() - this.resumedAt;
    for (const loop of this.loops) this.stopChunk(loop);
    this.handlers.onState('paused');
  }

  resume(): void {
    if (!this.running || !this.paused) return;
    this.paused = false;
    this.resumedAt = performance.now();
    for (const loop of this.loops) this.startChunk(loop);
    this.handlers.onState('recording');
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    if (!this.paused) this.activeMs += performance.now() - this.resumedAt;
    this.running = false;
    this.paused = false;

    if (this.levelTimer !== null) window.clearInterval(this.levelTimer);
    if (this.silenceTimer !== null) window.clearInterval(this.silenceTimer);
    this.levelTimer = null;
    this.silenceTimer = null;

    const finished: Promise<void>[] = [];
    for (const loop of this.loops) {
      finished.push(this.stopChunk(loop));
      if (loop.timer !== null) window.clearTimeout(loop.timer);
      loop.timer = null;
    }
    this.stopping = Promise.all(finished).then(() => {
      for (const loop of this.loops) {
        loop.stream.getTracks().forEach((track) => track.stop());
      }
      this.loops = [];
      void this.audioContext?.close();
      this.audioContext = null;
      this.handlers.onLevel(0, 0);
      this.handlers.onState('stopped');
    });
    await this.stopping;
  }

  private addLoop(source: 'mic' | 'system', stream: MediaStream): void {
    const context = this.audioContext;
    if (!context) return;
    const input = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    analyser.fftSize = 1024;
    const sink = context.createGain();
    sink.gain.value = 0;
    input.connect(analyser);
    analyser.connect(sink);
    sink.connect(context.destination);
    this.loops.push({
      source,
      stream,
      recorder: null,
      chunks: [],
      chunkStart: 0,
      timer: null,
      analyser,
      samples: new Uint8Array(analyser.fftSize),
    });
    stream.getAudioTracks()[0]?.addEventListener('ended', () => {
      if (this.running && source === 'mic') {
        this.handlers.onNotice('The microphone stopped. Recording was ended.');
        this.handlers.onAutoStop('microphone disconnected');
      }
    });
  }

  private startChunk(loop: SourceLoop): void {
    if (!this.running || this.paused) return;
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
      ? 'audio/webm;codecs=opus'
      : MediaRecorder.isTypeSupported('audio/webm')
        ? 'audio/webm'
        : '';
    let recorder: MediaRecorder;
    try {
      recorder = new MediaRecorder(loop.stream, mime ? { mimeType: mime } : {});
    } catch {
      this.handlers.onNotice('This machine cannot record audio in the app.');
      return;
    }
    loop.recorder = recorder;
    loop.chunks = [];
    loop.chunkStart = this.elapsedMs;
    recorder.ondataavailable = (event) => {
      if (event.data.size > 0) loop.chunks.push(event.data);
    };
    recorder.onstop = () => {
      const blob = new Blob(loop.chunks, {
        type: recorder.mimeType || 'audio/webm',
      });
      loop.chunks = [];
      loop.recorder = null;
      if (blob.size > 1200) {
        this.handlers.onChunk(
          loop.source,
          blob,
          loop.chunkStart,
          this.elapsedMs,
        );
      }
      if (this.running && !this.paused) this.startChunk(loop);
    };
    recorder.start();
    loop.timer = window.setTimeout(() => {
      if (recorder.state === 'recording') recorder.stop();
    }, CHUNK_MS);
  }

  private stopChunk(loop: SourceLoop): Promise<void> {
    if (loop.timer !== null) window.clearTimeout(loop.timer);
    loop.timer = null;
    const recorder = loop.recorder;
    if (!recorder || recorder.state === 'inactive') return Promise.resolve();
    return new Promise((resolve) => {
      recorder.addEventListener('stop', () => resolve(), { once: true });
      recorder.stop();
    });
  }

  private tickLevels(): void {
    let me = 0;
    let them = 0;
    for (const loop of this.loops) {
      const level = this.level(loop);
      if (loop.source === 'mic') me = level;
      else them = level;
    }
    if (me > LOUD || them > LOUD) this.lastLoudAt = this.elapsedMs;
    this.handlers.onLevel(me, them);
  }

  private level(loop: SourceLoop): number {
    loop.analyser.getByteTimeDomainData(loop.samples);
    let sum = 0;
    for (const sample of loop.samples) {
      const value = (sample - 128) / 128;
      sum += value * value;
    }
    return Math.min(1, Math.sqrt(sum / loop.samples.length) * 4);
  }

  private checkSilence(): void {
    if (!this.running || this.paused) return;
    const silentFor = this.elapsedMs - this.lastLoudAt;
    if (silentFor > SILENCE_AFTER_MS) {
      this.handlers.onAutoStop('15 minutes of silence');
    }
  }
}
