# =============================================================================
# Miriad Cloud Runtime Container
#
# Multi-stage build that compiles @miriad-systems/backend from source.
# Build from monorepo root: docker build -t miriad-cloud -f agents/miriad-cloud/Dockerfile .
# =============================================================================

# =============================================================================
# Stage 1: Build local-runtime from source
# =============================================================================
FROM node:20-bookworm AS builder

WORKDIR /build

# Copy package files first for dependency caching
COPY backend/packages/local-runtime/package*.json ./local-runtime/

# Install dependencies
WORKDIR /build/local-runtime
RUN npm install

# Copy source and build
WORKDIR /build
COPY backend/packages/local-runtime ./local-runtime
WORKDIR /build/local-runtime
RUN npm run build

# =============================================================================
# Stage 2: Runtime image
# =============================================================================
FROM node:20-bookworm

# Install dev tools needed by Claude Code agents
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    curl \
    jq \
    openssh-client \
    python3 \
    build-essential \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install rathole client for HTTP tunneling
ARG RATHOLE_VERSION=0.5.0
ARG TARGETARCH
RUN ARCH=$(case ${TARGETARCH:-amd64} in \
        amd64) echo "x86_64-unknown-linux-gnu" ;; \
        arm64) echo "aarch64-unknown-linux-musl" ;; \
        *) echo "x86_64-unknown-linux-gnu" ;; \
    esac) && \
    curl -fsSL "https://github.com/rathole-org/rathole/releases/download/v${RATHOLE_VERSION}/rathole-${ARCH}.zip" -o /tmp/rathole.zip && \
    cd /tmp && unzip rathole.zip && mv rathole /usr/local/bin/ && chmod +x /usr/local/bin/rathole && rm -rf /tmp/rathole*

# Install git shim for credential management
COPY agents/miriad-cloud/scripts/cmd-shim /usr/bin/cmd-shim
COPY agents/miriad-cloud/scripts/git-credential-token /usr/bin/git-credential-token
RUN chmod +x /usr/bin/cmd-shim /usr/bin/git-credential-token && \
    mv /usr/bin/git /usr/bin/git.real && ln -s /usr/bin/cmd-shim /usr/bin/git
RUN git.real config --system credential.helper '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install cast-tunnel CLI
COPY agents/miriad-cloud/scripts/cast-tunnel /usr/local/bin/cast-tunnel
RUN chmod +x /usr/local/bin/cast-tunnel

# Create workspace and app directories
RUN mkdir -p /workspace /app
WORKDIR /app

# Copy built local-runtime from builder stage
COPY --from=builder /build/local-runtime/dist ./dist
COPY --from=builder /build/local-runtime/node_modules ./node_modules
COPY --from=builder /build/local-runtime/package.json ./package.json

# Create non-root user (Claude Code requires non-root for unrestricted mode)
RUN useradd -m -s /bin/bash agent && chown -R agent:agent /app /workspace

USER agent
WORKDIR /workspace

# Environment variables set at runtime:
#   MIRIAD_CONFIG      - JSON config with credentials (RuntimeConfig)
#   ANTHROPIC_API_KEY  - Claude API key
#   GITHUB_TOKEN       - (optional) For git operations
#
# Config format (MIRIAD_CONFIG):
# {
#   "spaceId": "space_xxx",
#   "name": "miriad-cloud",
#   "credentials": {
#     "runtimeId": "rt_xxx",
#     "serverId": "srv_xxx",
#     "secret": "sk_cast_xxx",
#     "apiUrl": "https://api.miriad.systems",
#     "wsUrl": "wss://api.miriad.systems"
#   },
#   "workspace": { "basePath": "/workspace" }
# }

# Run local-runtime CLI
CMD ["node", "/app/dist/cli.js", "start"]
