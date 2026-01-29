#!/bin/bash
# Miriad Cloud startup script
# Runs AFTER Fly.io mounts the volume at /workspace

# Create directory structure for HOME=/workspace/home
mkdir -p "$HOME/.npm-global/bin" "$HOME/.npm-global/lib"

# Install Claude Code skills if not already present
if [ ! -d "$HOME/.claude/skills" ]; then
    echo "Installing Claude Code skills..."
    npx skills add -g --yes vercel-labs/skills@find-skills || true
fi

# Start the runtime
exec node /app/dist/cli.js start --idle-timeout 15
