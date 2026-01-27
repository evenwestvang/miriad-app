#!/bin/bash
# Entrypoint script for miriad-cloud container
# Ensures workspace directories exist before starting the runtime

# Create npm global directory structure (NPM_CONFIG_PREFIX points here)
# npm expects both bin/ and lib/ to exist
mkdir -p /workspace/.npm-global/bin /workspace/.npm-global/lib

# Execute the command passed to the container
exec "$@"
