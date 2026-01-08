# Cast Tunnel Server
# Auth wrapper + health endpoint for rathole tunnel server

FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package.json ./
RUN npm install

# Copy source and build
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# =============================================================================
# Production image
# =============================================================================

FROM node:20-alpine

WORKDIR /app

# Install rathole binary
# TODO: Download from releases or build from source
# For now, this is a placeholder - will be updated once @fox confirms the setup
ARG RATHOLE_VERSION=0.5.0
RUN apk add --no-cache curl && \
    echo "TODO: Install rathole ${RATHOLE_VERSION} binary" && \
    apk del curl

# Copy built app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Rathole config directory
RUN mkdir -p /etc/rathole

# Environment
ENV NODE_ENV=production
ENV PORT=2333

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:2333/health || exit 1

# Expose ports
# 2333 - Auth wrapper / health check
# Rathole will use additional ports for tunnel connections
EXPOSE 2333

# Start auth wrapper (rathole startup to be added)
CMD ["node", "dist/index.js"]
