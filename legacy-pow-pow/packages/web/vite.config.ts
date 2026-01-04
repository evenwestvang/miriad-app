import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import basicSsl from '@vitejs/plugin-basic-ssl'
import path from 'path'

export default defineConfig({
  plugins: [react(), basicSsl()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: 'dist',
  },
  server: {
    host: true, // Listen on all interfaces
    allowedHosts: ['localhost', '100.88.99.17', 'ssvale-max.tail92b950.ts.net'],
    proxy: {
      '/api': 'http://localhost:3232',
      '/mcp': 'http://localhost:3232',
      '/boards': 'http://localhost:3232',
    },
  },
})
