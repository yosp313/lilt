declare module '*.css' {
  const content: string;
  export default content;
}

declare module 'sherpa-onnx-node' {
  interface EmbeddingStream {
    acceptWaveform(input: { sampleRate: number; samples: Float32Array }): void;
  }
  class SpeakerEmbeddingExtractor {
    constructor(config: {
      model: string;
      numThreads?: number;
      debug?: boolean;
    });
    readonly dim: number;
    createStream(): EmbeddingStream;
    compute(stream: EmbeddingStream): Float32Array;
  }
  const sherpa: {
    SpeakerEmbeddingExtractor: typeof SpeakerEmbeddingExtractor;
  };
  export default sherpa;
}

declare const MAIN_WINDOW_VITE_DEV_SERVER_URL: string;
declare const MAIN_WINDOW_VITE_NAME: string;
