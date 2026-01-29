#!/bin/bash
# Entrypoint script for miriad-cloud container
# Ensures workspace directories exist before starting the runtime

# Create npm global directory structure (NPM_CONFIG_PREFIX points here)
# npm expects both bin/ and lib/ to exist
mkdir -p /workspace/.npm-global/bin /workspace/.npm-global/lib

# Install Claude Code skills if not already present
# Skills must be installed at runtime since /workspace is a mounted volume
if [ ! -d "/workspace/.claude/skills" ]; then
    mkdir -p /workspace/.claude
    npx --yes skills add -g vercel-labs/skills@find-skills 2>/dev/null || true
fi

# Execute the command passed to the container
exec "$@"
