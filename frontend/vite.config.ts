import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5174, // Use non-default port to avoid conflicts
    allowedHosts: true, // Allow all hosts (for VPN/Tailscale access)
    // Only proxy in development mode (not aws mode)
    ...(mode !== 'aws' && {
      proxy: {
        // Proxy API requests to backend server
        '/channels': {
          target: 'http://localhost:3234',
          changeOrigin: true,
        },
        '/auth': {
          target: 'http://localhost:3234',
          changeOrigin: true,
        },
        '/api': {
          target: 'http://localhost:3234',
          changeOrigin: true,
        },
      },
    }),
  },
}))
