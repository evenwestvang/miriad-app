#!/bin/bash
# Deploy Cast Backend to AWS
# Uses SSO profile cikada-stag

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

echo "Building Lambda bundle..."
node build.mjs

echo ""
echo "Deploying to AWS (cast-stag)..."
sam build && sam deploy --config-env cast-stag

echo ""
echo "Deployment complete!"
