# Cast Tunnel Server
# Auth wrapper + routing proxy + rathole tunnel server

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

# Install rathole binary from GitHub releases
ARG RATHOLE_VERSION=0.4.8
ARG TARGETARCH

RUN apk add --no-cache curl ca-certificates && \
    # Map Docker arch to rathole arch
    case "${TARGETARCH:-amd64}" in \
      amd64) RATHOLE_ARCH="x86_64-unknown-linux-musl" ;; \
      arm64) RATHOLE_ARCH="aarch64-unknown-linux-musl" ;; \
      *) echo "Unsupported arch: ${TARGETARCH}" && exit 1 ;; \
    esac && \
    # Download and extract rathole
    curl -fsSL "https://github.com/rathole-org/rathole/releases/download/v${RATHOLE_VERSION}/rathole-${RATHOLE_ARCH}.zip" -o /tmp/rathole.zip && \
    unzip /tmp/rathole.zip -d /tmp && \
    mv /tmp/rathole /usr/local/bin/rathole && \
    chmod +x /usr/local/bin/rathole && \
    # Cleanup
    rm -rf /tmp/rathole.zip && \
    apk del curl && \
    # Verify installation
    rathole --version

# Copy built app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./

# Rathole config directory
RUN mkdir -p /etc/rathole

# Copy startup script
COPY start.sh /app/start.sh
RUN chmod +x /app/start.sh

# Environment
ENV NODE_ENV=production
ENV PORT=8080
ENV RATHOLE_CONTROL_PORT=2333
ENV RATHOLE_CONFIG_DIR=/etc/rathole
ENV BASE_SERVICE_PORT=10000

# Health check targets Hono (the proxy layer)
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:8080/health || exit 1

# Expose ports
# 8080 - Hono proxy (ALB target)
# 2333 - Rathole control port (containers connect here)
# 10000+ - Dynamic service ports (tunneled traffic)
EXPOSE 8080 2333

# Start both services
CMD ["/app/start.sh"]
