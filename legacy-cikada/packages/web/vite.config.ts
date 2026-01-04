import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  server: {
    port: 5173,
    allowedHosts: true, // Allow all hosts (for VPN/Tailscale access)
    // Only proxy in development mode (not aws mode)
    ...(mode !== 'aws' && {
      proxy: {
        // Proxy API requests to backend server
        '/channels': {
          target: 'http://localhost:3001',
          changeOrigin: true,
        },
      },
    }),
  },
}))
