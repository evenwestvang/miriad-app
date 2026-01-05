# Claude Code Fargate Container
# Runs Claude Code CLI with a wrapper server for HTTP communication

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
    && rm -rf /var/lib/apt/lists/*

# Install Claude Code CLI globally
RUN npm install -g @anthropic-ai/claude-code

# Create workspace directory (will be mounted from EFS)
RUN mkdir -p /workspace

# Create app directory
WORKDIR /app

# Copy pre-built dist files (built by pnpm build in monorepo)
# This avoids workspace:* dependency resolution issues
COPY dist/ ./dist/

# Install runtime dependencies directly (avoiding workspace:* resolution)
RUN npm install --no-save \
    @aws-sdk/client-apigatewaymanagementapi@^3.958.0 \
    @aws-sdk/client-dynamodb@^3.450.0 \
    @aws-sdk/client-ecs@^3.450.0 \
    @aws-sdk/lib-dynamodb@^3.450.0 \
    @modelcontextprotocol/sdk@^1.0.0

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

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080

# Run the wrapper server (compiled to dist/src/server.js)
CMD ["node", "dist/src/server.js"]
