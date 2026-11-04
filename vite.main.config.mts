import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    rollupOptions: {
      // Native addon: a bare require must survive, not get bundled.
      external: ['sherpa-onnx-node'],
    },
  },
});
