import { resolve } from 'node:path';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { protobufCspAotPlugin } from './build/protobufCspAotPlugin';

export default defineConfig({
  plugins: [react(), protobufCspAotPlugin()],
  base: './',
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['or-tools-wasm'],
  },
  worker: {
    format: 'es',
    plugins: () => [protobufCspAotPlugin()],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background/index.ts'),
        'content-overlay': resolve(__dirname, 'src/content/overlay.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          if (chunkInfo.name === 'background' || chunkInfo.name === 'content-overlay') {
            return '[name].js';
          }
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
});
