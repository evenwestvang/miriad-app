import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'

// Default backend URL for local development
const BACKEND_URL = process.env.VITE_BACKEND_URL || 'http://localhost:3234'

// Redirect asset requests to backend (mirrors Vercel Edge Middleware behavior)
// Uses 302 redirect for consistency with production
function assetRedirectPlugin(): Plugin {
  return {
    name: 'asset-redirect',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url?.match(/^\/channels\/[^/]+\/assets\//)) {
          res.writeHead(302, { Location: `${BACKEND_URL}${req.url}` })
          res.end()
          return
        }
        next()
      })
    },
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react(), assetRedirectPlugin()],
  // Define backend URL as compile-time constant - single source of truth
  define: {
    'import.meta.env.VITE_BACKEND_URL': JSON.stringify(BACKEND_URL),
  },
  server: {
    port: 5174, // Use non-default port to avoid conflicts
    allowedHosts: true, // Allow all hosts (for VPN/Tailscale access)
  },
}))
