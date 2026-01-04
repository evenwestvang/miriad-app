#!/usr/bin/env node
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const DIST_DIR = path.join(__dirname, '..', 'dist')
const PORT = process.env.PORT || 5173
const POWPOW_URL = process.env.POWPOW_URL || 'http://localhost:3131'

const MIME_TYPES = {
  '.html': 'text/html',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
}

// Check if dist exists
if (!fs.existsSync(DIST_DIR)) {
  console.error('Error: dist folder not found. Run "npm run build" first.')
  process.exit(1)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost')
  
  // Proxy API requests to PowPow server
  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/mcp/')) {
    const targetUrl = POWPOW_URL + req.url
    
    try {
      const headers = { ...req.headers }
      delete headers.host
      
      const proxyRes = await fetch(targetUrl, {
        method: req.method,
        headers,
        body: req.method !== 'GET' && req.method !== 'HEAD' ? req : undefined,
        duplex: 'half',
      })
      
      // Handle SSE
      if (proxyRes.headers.get('content-type')?.includes('text/event-stream')) {
        res.writeHead(proxyRes.status, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive',
          'Access-Control-Allow-Origin': '*',
        })
        
        const reader = proxyRes.body?.getReader()
        if (reader) {
          const pump = async () => {
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                res.write(value)
              }
            } catch {}
            res.end()
          }
          pump()
          req.on('close', () => reader.cancel())
        }
        return
      }
      
      // Regular response
      const body = await proxyRes.text()
      res.writeHead(proxyRes.status, {
        'Content-Type': proxyRes.headers.get('content-type') || 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      })
      res.end(body)
    } catch (err) {
      res.writeHead(502)
      res.end('Bad Gateway: Could not connect to PowPow server at ' + POWPOW_URL)
    }
    return
  }
  
  // CORS preflight
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    })
    res.end()
    return
  }
  
  // Serve static files
  let filePath = path.join(DIST_DIR, url.pathname)
  
  // Default to index.html for SPA routing
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    filePath = path.join(DIST_DIR, 'index.html')
  }
  
  const ext = path.extname(filePath)
  const contentType = MIME_TYPES[ext] || 'application/octet-stream'
  
  try {
    const content = fs.readFileSync(filePath)
    res.writeHead(200, { 'Content-Type': contentType })
    res.end(content)
  } catch {
    res.writeHead(404)
    res.end('Not Found')
  }
})

server.listen(PORT, () => {
  console.log('')
  console.log('  PowPow Web Client')
  console.log('')
  console.log('  Local:   http://localhost:' + PORT)
  console.log('  Server:  ' + POWPOW_URL)
  console.log('')
})
