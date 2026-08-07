import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const API = process.env.MYBOT_API ?? 'http://127.0.0.1:4317';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5317,
    proxy: { '/api': { target: API, changeOrigin: true } },
  },
  build: { outDir: 'dist', emptyOutDir: true },
});
