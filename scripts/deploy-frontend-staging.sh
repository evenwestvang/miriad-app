#!/bin/bash
# Deploy Cast Frontend to Vercel (Staging)
#
# This script deploys the frontend to Vercel with staging environment variables.
#
# Prerequisites:
#   - Vercel CLI installed (npm i -g vercel)
#   - Logged in to Vercel (vercel login)
#
# Usage:
#   ./scripts/deploy-frontend-staging.sh           # Production deploy
#   ./scripts/deploy-frontend-staging.sh --preview # Preview deploy

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
FRONTEND_DIR="$REPO_ROOT/frontend"

# Staging environment configuration
VITE_BACKEND_URL="https://api.staging.caststack.ai"
VITE_WS_URL="wss://ws.staging.caststack.ai"
VITE_AUTH_MODE="workos"

# Parse arguments
PRODUCTION=true
if [[ "$1" == "--preview" ]]; then
    PRODUCTION=false
fi

echo "Cast Frontend Deployment (Staging)"
echo "==================================="
echo ""
echo "  Backend URL: $VITE_BACKEND_URL"
echo "  WS URL:      $VITE_WS_URL"
echo "  Auth Mode:   $VITE_AUTH_MODE"
echo "  Mode:    $([ "$PRODUCTION" = true ] && echo "Production" || echo "Preview")"
echo ""

cd "$FRONTEND_DIR"

# Check Vercel CLI
if ! command -v vercel &> /dev/null; then
    echo "Error: Vercel CLI not installed. Run: npm i -g vercel"
    exit 1
fi

# Build and deploy
echo "Deploying to Vercel..."
echo ""

if [ "$PRODUCTION" = true ]; then
    vercel --prod \
        --build-env VITE_BACKEND_URL="$VITE_BACKEND_URL" \
        --build-env VITE_WS_URL="$VITE_WS_URL" \
        --build-env VITE_AUTH_MODE="$VITE_AUTH_MODE"
else
    vercel \
        --build-env VITE_BACKEND_URL="$VITE_BACKEND_URL" \
        --build-env VITE_WS_URL="$VITE_WS_URL" \
        --build-env VITE_AUTH_MODE="$VITE_AUTH_MODE"
fi

echo ""
echo "==================================="
echo "Frontend deployment complete!"
echo "==================================="
echo ""
echo "Staging: https://app.staging.caststack.ai"
echo ""
