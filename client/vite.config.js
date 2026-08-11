import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.MYBOT_API ?? 'http://127.0.0.1:4317';

const BUILD = new Date().toISOString().slice(0, 16).replace('T', ' ');

export default defineConfig({
  define: { __BUILD__: JSON.stringify(BUILD) },
  plugins: [react()],
  server: {
    port: 5317,
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
