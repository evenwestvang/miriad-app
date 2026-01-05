# Claude Code Container with Cast MCP Tools
#
# Runs Claude Code CLI with a wrapper HTTP server.
# The wrapper spawns Claude Code and provides MCP tools via stdio.

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

# Create workspace directory
RUN mkdir -p /workspace

# Create app directory
WORKDIR /app

# Copy package files
COPY package.json ./

# Install dependencies
RUN npm install --no-save @modelcontextprotocol/sdk@^1.0.0

# Copy built wrapper server and MCP server
COPY dist/ ./dist/

# Create non-root user for Claude Code
# (--dangerously-skip-permissions cannot be used with root)
RUN useradd -m -s /bin/bash claude && \
    chown -R claude:claude /app /workspace

# Switch to non-root user
USER claude

# Environment variables (set at runtime via Docker/ECS)
# ANTHROPIC_API_KEY - Claude API key
# CAST_API_URL - Cast backend URL
# CAST_CHANNEL_ID - Agent's channel
# CAST_CALLSIGN - Agent's callsign
# CAST_AUTH_TOKEN - Container auth token
# THREAD_ID - Agent thread identifier
# WORKSPACE_DIR - Working directory (default: /workspace)
# IDLE_TIMEOUT_MS - Idle timeout in milliseconds

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:8080/health || exit 1

EXPOSE 8080

# Run the wrapper server (which spawns Claude Code with MCP config)
CMD ["node", "dist/server.js"]
