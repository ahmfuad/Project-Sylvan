import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';
import pkg from './package.json' with { type: 'json' };

const API_TARGET = 'http://127.0.0.1:3100';

// Shown in the footer: package version plus the deployed commit (set by deploy/ci-deploy.sh).
const COMMIT = (process.env.SYLVAN_COMMIT ?? process.env.GITHUB_SHA ?? 'dev').slice(0, 7);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  define: {
    __APP_VERSION__: JSON.stringify(`v${pkg.version} · ${COMMIT}`),
  },
  server: {
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': API_TARGET,
      '/photos': API_TARGET,
      '/ws': { target: API_TARGET, ws: true },
    },
  },
  preview: {
    host: '127.0.0.1',
    port: 4173,
    proxy: {
      '/api': API_TARGET,
      '/photos': API_TARGET,
      '/ws': { target: API_TARGET, ws: true },
    },
  },
  build: {
    outDir: 'dist',
    target: 'es2022',
    sourcemap: false,
    reportCompressedSize: true,
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./vitest.setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    // Fixed zone so date formatting and day boundaries are deterministic.
    env: { TZ: 'Asia/Dhaka' },
    css: false,
  },
});
