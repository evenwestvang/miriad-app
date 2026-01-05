#!/usr/bin/env bash
#
# build-containers.sh - Build CAST agent containers for local Docker use
#
# Usage:
#   ./scripts/build-containers.sh [options]
#
# Options:
#   --sandbox     Build only the sandbox agent container (default: build all)
#   --no-cache    Build without Docker cache
#   --push        Push to registry (requires REGISTRY env var)
#   -h, --help    Show this help message
#
# Examples:
#   ./scripts/build-containers.sh                    # Build all containers
#   ./scripts/build-containers.sh --sandbox          # Build sandbox only
#   ./scripts/build-containers.sh --no-cache         # Fresh build
#
# Output:
#   cast-sandbox:local    Sandbox agent container
#
# Prerequisites:
#   - Docker installed and running
#   - Node.js 20+ and pnpm installed
#

set -euo pipefail

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# Defaults
BUILD_SANDBOX=true
NO_CACHE=""
PUSH=false

# Parse arguments
while [[ $# -gt 0 ]]; do
  case $1 in
    --sandbox)
      BUILD_SANDBOX=true
      shift
      ;;
    --no-cache)
      NO_CACHE="--no-cache"
      shift
      ;;
    --push)
      PUSH=true
      shift
      ;;
    -h|--help)
      head -30 "$0" | tail -n +2 | sed 's/^# //' | sed 's/^#//'
      exit 0
      ;;
    *)
      echo -e "${RED}Unknown option: $1${NC}"
      exit 1
      ;;
  esac
done

# Check prerequisites
check_prerequisites() {
  echo -e "${YELLOW}Checking prerequisites...${NC}"

  if ! command -v docker &> /dev/null; then
    echo -e "${RED}Error: Docker is not installed${NC}"
    exit 1
  fi

  if ! docker info &> /dev/null; then
    echo -e "${RED}Error: Docker daemon is not running${NC}"
    exit 1
  fi

  if ! command -v pnpm &> /dev/null; then
    echo -e "${RED}Error: pnpm is not installed${NC}"
    exit 1
  fi

  echo -e "${GREEN}Prerequisites OK${NC}"
}

# Build sandbox agent container
build_sandbox() {
  echo -e "${YELLOW}Building sandbox agent container...${NC}"

  local sandbox_dir="$ROOT_DIR/agents/sandbox"

  # Step 1: Build TypeScript
  echo "  → Building TypeScript..."
  cd "$sandbox_dir"
  pnpm install --frozen-lockfile 2>/dev/null || pnpm install
  pnpm build

  # Step 2: Build Docker image
  echo "  → Building Docker image..."
  docker build $NO_CACHE -t cast-sandbox:local "$sandbox_dir"

  echo -e "${GREEN}✓ Built cast-sandbox:local${NC}"

  # Show image info
  docker images cast-sandbox:local --format "  Size: {{.Size}}, Created: {{.CreatedSince}}"
}

# Main
main() {
  echo "========================================"
  echo "  CAST Container Builder"
  echo "========================================"
  echo ""

  check_prerequisites
  echo ""

  if [ "$BUILD_SANDBOX" = true ]; then
    build_sandbox
    echo ""
  fi

  echo -e "${GREEN}Build complete!${NC}"
  echo ""
  echo "To run the sandbox container locally:"
  echo "  docker run -e ANTHROPIC_API_KEY=\$ANTHROPIC_API_KEY \\"
  echo "             -e CALLSIGN=fox \\"
  echo "             -e CHANNEL_ID=test-channel \\"
  echo "             -e CAST_SERVER_URL=http://host.docker.internal:3001 \\"
  echo "             -p 8080:8080 \\"
  echo "             cast-sandbox:local"
}

main "$@"
