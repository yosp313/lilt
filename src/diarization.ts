import fs from 'node:fs';
import path from 'node:path';
import sherpa from 'sherpa-onnx-node';
import { DIARIZATION_MODEL } from './shared/logic.ts';

export function diarizationModelPath(dataDir: string): string {
  return path.join(dataDir, 'models', DIARIZATION_MODEL.file);
}

export function diarizationReady(dataDir: string): boolean {
  return fs.existsSync(diarizationModelPath(dataDir));
}

let extractor: InstanceType<typeof sherpa.SpeakerEmbeddingExtractor> | null =
  null;

/**
 * Voice embedding for 16 kHz mono PCM. The extractor keeps the ONNX model
 * resident between chunks; the renderer decides which speaker it belongs to.
 *
 * shortcut: whole-chunk embedding only, so a chunk with two speakers gets one
 * label. Upgrade path: split the chunk with pyannote segmentation and embed
 * each turn when cross-talk starts mattering.
 */
export function voiceEmbedding(
  dataDir: string,
  pcm: Float32Array,
): Float32Array {
  extractor ??= new sherpa.SpeakerEmbeddingExtractor({
    model: diarizationModelPath(dataDir),
    numThreads: 1,
  });
  const stream = extractor.createStream();
  stream.acceptWaveform({ sampleRate: 16000, samples: pcm });
  return extractor.compute(stream);
}
