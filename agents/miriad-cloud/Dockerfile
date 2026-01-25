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

WORKDIR /build/local-runtime

# Copy entire package (source + package.json)
COPY backend/packages/local-runtime/ ./

# Install dependencies and build
RUN npm install && npm run build

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
    python3-pip \
    python3-venv \
    build-essential \
    unzip \
    ca-certificates \
    && rm -rf /var/lib/apt/lists/*

# Install uv for fast Python package management
RUN curl -LsSf https://astral.sh/uv/install.sh | sh && \
    mv /root/.local/bin/uv /usr/local/bin/uv && \
    mv /root/.local/bin/uvx /usr/local/bin/uvx

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

# Install Bun (fast JavaScript runtime for Nuum agent engine)
ARG BUN_VERSION=1.3.6
RUN ARCH=$(case ${TARGETARCH:-amd64} in \
        amd64) echo "x64-baseline" ;; \
        arm64) echo "aarch64" ;; \
        *) echo "x64-baseline" ;; \
    esac) && \
    curl -fsSL "https://github.com/oven-sh/bun/releases/download/bun-v${BUN_VERSION}/bun-linux-${ARCH}.zip" -o /tmp/bun.zip && \
    cd /tmp && unzip -q bun.zip && mv bun-linux-${ARCH}/bun /usr/local/bin/bun && \
    ln -s /usr/local/bin/bun /usr/local/bin/bunx && \
    chmod +x /usr/local/bin/bun && rm -rf /tmp/bun*

# Install git shim for credential management
COPY agents/miriad-cloud/scripts/cmd-shim /usr/bin/cmd-shim
COPY agents/miriad-cloud/scripts/git-credential-token /usr/bin/git-credential-token
RUN chmod +x /usr/bin/cmd-shim /usr/bin/git-credential-token && \
    mv /usr/bin/git /usr/bin/git.real && ln -s /usr/bin/cmd-shim /usr/bin/git
RUN git.real config --system credential.helper '!f() { echo "username=x-access-token"; echo "password=$GITHUB_TOKEN"; }; f'

# Install Claude Code CLI
RUN npm install -g @anthropic-ai/claude-code

# Install miriad-tunnel CLI
COPY agents/miriad-cloud/scripts/miriad-tunnel /usr/local/bin/miriad-tunnel
RUN chmod +x /usr/local/bin/miriad-tunnel

# Install entrypoint script (ensures workspace dirs exist on volume mount)
COPY agents/miriad-cloud/scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Create workspace and app directories
RUN mkdir -p /workspace /app
WORKDIR /app

# Copy built local-runtime from builder stage
COPY --from=builder /build/local-runtime/dist ./dist
COPY --from=builder /build/local-runtime/node_modules ./node_modules
COPY --from=builder /build/local-runtime/package.json ./

# Create non-root user (Claude Code requires non-root for unrestricted mode)
RUN useradd -m -s /bin/bash agent && chown -R agent:agent /app /workspace

USER agent
WORKDIR /workspace

# Configure package installs to use workspace (persists on volume)
# Note: Python enforces venv usage (EXTERNALLY-MANAGED) - this is intentional
ENV NPM_CONFIG_PREFIX=/workspace/.npm-global
ENV PATH="/workspace/.npm-global/bin:$PATH"

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

# Run local-runtime CLI with 15 minute idle timeout
# Container will exit after 15 minutes of inactivity
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["node", "/app/dist/cli.js", "start", "--idle-timeout", "15"]
