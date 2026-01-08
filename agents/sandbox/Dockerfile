# Claude Agent SDK Container
# Uses Claude Agent SDK directly (replaces CLI subprocess approach)
# Phase 2 implementation

FROM node:20-bullseye

# Install common dev tools needed by Claude Code
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    bash \
    curl \
    jq \
    openssh-client \
    python3 \
    python3-pip \
    build-essential \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install rathole client for HTTP tunneling
# Using pre-built binary from GitHub releases
# Note: v0.5.0 changed ARM64 builds from gnu to musl
ARG RATHOLE_VERSION=0.5.0
ARG TARGETARCH
RUN ARCH=$(case ${TARGETARCH:-amd64} in \
        amd64) echo "x86_64-unknown-linux-gnu" ;; \
        arm64) echo "aarch64-unknown-linux-musl" ;; \
        *) echo "x86_64-unknown-linux-gnu" ;; \
    esac) && \
    curl -fsSL "https://github.com/rathole-org/rathole/releases/download/v${RATHOLE_VERSION}/rathole-${ARCH}.zip" -o /tmp/rathole.zip && \
    cd /tmp && unzip rathole.zip && \
    mv rathole /usr/local/bin/rathole && \
    chmod +x /usr/local/bin/rathole && \
    rm -rf /tmp/rathole*

# Install Claude Code CLI globally (SDK requires CLI to be available)
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directory (will be mounted from EFS)
RUN mkdir -p /workspace

# Create app directory
WORKDIR /app

# Copy pre-built dist files (built by pnpm build in monorepo)
# This avoids workspace:* dependency resolution issues
COPY dist/ ./dist/

# Install runtime dependencies directly (avoiding workspace:* resolution)
# Note: @anthropic-ai/claude-agent-sdk is the SDK (not CLI)
RUN npm install --no-save \
    @anthropic-ai/claude-agent-sdk@^0.1.76 \
    @aws-sdk/client-apigatewaymanagementapi@^3.958.0 \
    @aws-sdk/client-dynamodb@^3.450.0 \
    @aws-sdk/client-ecs@^3.450.0 \
    @aws-sdk/lib-dynamodb@^3.450.0 \
    @modelcontextprotocol/sdk@^1.0.0

# Copy tunnel CLI script
COPY scripts/cast-tunnel /usr/local/bin/cast-tunnel
RUN chmod +x /usr/local/bin/cast-tunnel

# Create non-root user for Claude Code
# (--dangerously-skip-permissions cannot be used with root)
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app /workspace

# Switch to non-root user
USER claude

# Environment variables (set at runtime via ECS task definition)
# ANTHROPIC_API_KEY - Claude API key (from Secrets Manager)
# THREAD_ID - Thread identifier
# CIKADA_API_URL - Cikada HTTP API for Tymbal streaming
# WORKSPACE_DIR - Working directory (default: /workspace)
# IDLE_TIMEOUT_MS - Idle timeout in milliseconds (default: 600000 = 10 min)
#
# Tunnel configuration (for HTTP exposure via cast-tunnel):
# TUNNEL_SERVER_URL - Tunnel server address (host:port)
# TUNNEL_HASH - Unique hash for container's public hostname
# TUNNEL_TOKEN - Authentication token for tunnel server
# TUNNEL_LOCAL_PORT - Local port to expose (default: 8080)

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080

# Run the wrapper server (compiled to dist/src/server.js)
CMD ["node", "dist/src/server.js"]
