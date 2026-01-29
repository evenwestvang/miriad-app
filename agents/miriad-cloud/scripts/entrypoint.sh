#!/bin/bash
# Entrypoint script for miriad-cloud container
# Ensures workspace directories exist before starting the runtime

# Create home directory structure (HOME=/workspace/home)
# Keeps dotfiles/caches separate from user's working files
mkdir -p /workspace/home

# Create npm global directory structure (NPM_CONFIG_PREFIX points here)
# npm expects both bin/ and lib/ to exist
mkdir -p /workspace/home/.npm-global/bin /workspace/home/.npm-global/lib

# Install Claude Code skills if not already present
# Skills must be installed at runtime since /workspace is a mounted volume
if [ ! -d "/workspace/home/.claude/skills" ]; then
    mkdir -p /workspace/home/.claude
    npx --yes skills add -g vercel-labs/skills@find-skills 2>/dev/null || true
fi

# Execute the command passed to the container
exec "$@"
