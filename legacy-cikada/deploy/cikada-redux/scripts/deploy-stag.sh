#!/bin/bash
# Deploy to cikada-stag (staging environment)
# Account: 455626925815
#
# Usage: ./scripts/deploy-stag.sh
#
# This script:
# 1. Verifies you're targeting the correct AWS account
# 2. Builds and deploys the SAM stack
# 3. Outputs stack endpoints
# 4. Updates packages/web/.env.aws with current endpoints

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
WEB_DIR="$(dirname "$(dirname "$DEPLOY_DIR")")/packages/web"

EXPECTED_ACCOUNT="455626925815"
STACK_NAME="cikada-stag"
PROFILE="cikada-stag"
REGION="us-east-1"

echo "=============================================="
echo "  Deploying to cikada-stag"
echo "  Account: $EXPECTED_ACCOUNT"
echo "=============================================="
echo

# Verify correct AWS account
echo "Verifying AWS account..."
ACCOUNT_ID=$(aws sts get-caller-identity --profile "$PROFILE" --query Account --output text 2>/dev/null || echo "")

if [ -z "$ACCOUNT_ID" ]; then
    echo "ERROR: Could not get AWS account ID. Is the '$PROFILE' profile configured?"
    echo ""
    echo "To configure:"
    echo "  aws configure --profile $PROFILE"
    exit 1
fi

if [ "$ACCOUNT_ID" != "$EXPECTED_ACCOUNT" ]; then
    echo "ERROR: Wrong AWS account!"
    echo "  Expected: $EXPECTED_ACCOUNT"
    echo "  Got:      $ACCOUNT_ID"
    echo ""
    echo "Check your '$PROFILE' AWS profile configuration."
    exit 1
fi

echo "Account verified: $ACCOUNT_ID"
echo

# Change to deploy directory
cd "$DEPLOY_DIR"

# Build TypeScript first (ensure latest code is compiled)
echo "Building TypeScript..."
pnpm build

# Build SAM application
echo "Building SAM application..."
sam build

# Deploy using config-env
echo ""
echo "Deploying stack..."
sam deploy --config-env cikada-stag

# Get stack outputs
echo ""
echo "=============================================="
echo "  Stack Outputs"
echo "=============================================="

HTTP_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`HttpApiEndpoint`].OutputValue' \
    --output text)

WS_ENDPOINT=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --profile "$PROFILE" \
    --region "$REGION" \
    --query 'Stacks[0].Outputs[?OutputKey==`WebSocketEndpoint`].OutputValue' \
    --output text)

echo "HTTP API:    $HTTP_ENDPOINT"
echo "WebSocket:   $WS_ENDPOINT"
echo

# Update .env.aws for frontend (committed file - share with team)
if [ -d "$WEB_DIR" ]; then
    ENV_FILE="$WEB_DIR/.env.aws"

    # Read old endpoints if file exists
    OLD_API=""
    OLD_WS=""
    if [ -f "$ENV_FILE" ]; then
        OLD_API=$(grep "^VITE_API_URL=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 || echo "")
        OLD_WS=$(grep "^VITE_WS_URL=" "$ENV_FILE" 2>/dev/null | cut -d'=' -f2 || echo "")
    fi

    # Write new config
    cat > "$ENV_FILE" << EOF
# AWS Staging Backend Configuration
# Use with: pnpm --filter @cikada/web dev:aws
# Last updated: $(date)

VITE_API_URL=$HTTP_ENDPOINT
VITE_WS_URL=$WS_ENDPOINT
EOF

    echo "Updated: $ENV_FILE"

    # Check if endpoints changed
    if [ "$OLD_API" != "$HTTP_ENDPOINT" ] || [ "$OLD_WS" != "$WS_ENDPOINT" ]; then
        echo ""
        echo "=============================================="
        echo "  ENDPOINTS CHANGED - COMMIT RECOMMENDED"
        echo "=============================================="
        echo ""
        echo "The AWS endpoints have changed. Commit to share with your team:"
        echo ""
        echo "  git add packages/web/.env.aws"
        echo "  git commit -m \"chore: update AWS staging endpoints\""
        echo "  git push"
        echo ""
    fi
else
    echo "Warning: packages/web not found - skipping .env.aws update"
fi

echo ""
echo "=============================================="
echo "  Deploy complete!"
echo "=============================================="
