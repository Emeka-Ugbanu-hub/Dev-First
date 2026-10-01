import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

export default defineConfig({
  root: 'webview',
  base: './',
  plugins: [react()],
  build: {
    outDir: '../dist/webview',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      input: resolve(__dirname, 'webview/index.html'),
      output: {
        entryFileNames: 'webview.js',
        assetFileNames: 'webview[extname]',
        inlineDynamicImports: true,
      },
    },
  },
});
