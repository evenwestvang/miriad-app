#!/bin/bash
# Build Claude Code container locally for testing
#
# Usage:
#   ./scripts/build-local.sh           # Build only
#   ./scripts/build-local.sh --run     # Build and run interactively

set -e

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PACKAGE_DIR"

IMAGE_NAME="claude-code:local"

echo "Building Claude Code container locally..."
echo "  Package dir: $PACKAGE_DIR"
echo "  Image: $IMAGE_NAME"
echo ""

# Build TypeScript first
echo "Building TypeScript..."
npm run build

# Build Docker image
echo "Building Docker image..."
docker build -t "$IMAGE_NAME" .

echo ""
echo "Build complete: $IMAGE_NAME"

# Run if --run flag provided
if [[ "$1" == "--run" ]]; then
    echo ""
    echo "Running container interactively..."
    echo "  - Port 8080 exposed"
    echo "  - Press Ctrl+C to stop"
    echo ""

    # Check for required env vars
    if [[ -z "$ANTHROPIC_API_KEY" ]]; then
        echo "Warning: ANTHROPIC_API_KEY not set"
        echo "  Set it with: export ANTHROPIC_API_KEY=sk-..."
        echo ""
    fi

    docker run -it --rm \
        -p 8080:8080 \
        -e ANTHROPIC_API_KEY="${ANTHROPIC_API_KEY:-}" \
        -e CAST_API_URL="${CAST_API_URL:-http://localhost:3000}" \
        -e CAST_CHANNEL_ID="${CAST_CHANNEL_ID:-}" \
        -e CAST_CALLSIGN="${CAST_CALLSIGN:-}" \
        -e CAST_AUTH_TOKEN="${CAST_AUTH_TOKEN:-}" \
        -e THREAD_ID="${THREAD_ID:-test-thread}" \
        -e IDLE_TIMEOUT_MS="${IDLE_TIMEOUT_MS:-600000}" \
        -v "${PWD}/test-workspace:/workspace" \
        "$IMAGE_NAME"
fi
