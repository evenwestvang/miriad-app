#!/bin/bash
# Entrypoint script for miriad-cloud container
# Ensures workspace directories exist before starting the runtime

# Create npm global directory (NPM_CONFIG_PREFIX points here)
mkdir -p /workspace/.npm-global

# Execute the command passed to the container
exec "$@"
