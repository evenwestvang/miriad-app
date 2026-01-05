#!/bin/bash
# Deploy Cast to AWS Staging
#
# This script deploys both the agent container image and the backend API.
#
# Prerequisites:
#   - AWS CLI configured with 'cikada-stag' profile
#   - Docker running
#   - SAM CLI installed
#
# Usage:
#   ./scripts/deploy-staging.sh           # Deploy both container and backend
#   ./scripts/deploy-staging.sh --backend # Deploy backend only
#   ./scripts/deploy-staging.sh --container # Deploy container only

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-455626925815}"
ECR_REPO_NAME="cast-agent"
IMAGE_TAG="${IMAGE_TAG:-latest}"
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

# Parse arguments
DEPLOY_CONTAINER=true
DEPLOY_BACKEND=true

if [[ "$1" == "--backend" ]]; then
    DEPLOY_CONTAINER=false
elif [[ "$1" == "--container" ]]; then
    DEPLOY_BACKEND=false
fi

# =============================================================================
# Container Image Build + Push
# =============================================================================

deploy_container() {
    echo "=============================================="
    echo "Building and pushing agent container to ECR"
    echo "=============================================="
    echo "  ECR Repository: ${ECR_REPO_NAME}"
    echo "  Image Tag: ${IMAGE_TAG}"
    echo "  Full URI: ${ECR_URI}:${IMAGE_TAG}"
    echo ""

    cd "$REPO_ROOT/legacy-cikada/packages/fargate-runtime"

    # Build TypeScript
    echo "Building TypeScript..."
    npm run build

    # Login to ECR
    echo "Logging in to ECR..."
    aws ecr get-login-password --region "${AWS_REGION}" --profile cikada-stag | \
        docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

    # Build the image
    echo "Building Docker image..."
    docker build -t "${ECR_REPO_NAME}:${IMAGE_TAG}" .

    # Tag for ECR
    echo "Tagging image for ECR..."
    docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"

    # Push to ECR
    echo "Pushing image to ECR..."
    docker push "${ECR_URI}:${IMAGE_TAG}"

    echo ""
    echo "Container deployed: ${ECR_URI}:${IMAGE_TAG}"
}

# =============================================================================
# Backend API Deploy (Lambda + API Gateway)
# =============================================================================

deploy_backend() {
    echo "=============================================="
    echo "Deploying backend to AWS (cast-stag)"
    echo "=============================================="
    echo ""

    cd "$REPO_ROOT/backend/deploy"

    # Build Lambda bundle
    echo "Building Lambda bundle..."
    node build.mjs

    # Deploy with SAM
    echo "Running SAM build + deploy..."
    sam build && sam deploy --config-env cast-stag

    echo ""
    echo "Backend deployed!"
}

# =============================================================================
# Main
# =============================================================================

echo "Cast Staging Deployment"
echo "======================="
echo ""

if [[ "$DEPLOY_CONTAINER" == "true" ]]; then
    deploy_container
    echo ""
fi

if [[ "$DEPLOY_BACKEND" == "true" ]]; then
    deploy_backend
    echo ""
fi

echo "=============================================="
echo "Deployment complete!"
echo "=============================================="
echo ""
echo "Staging API: https://9xq1buuixd.execute-api.us-east-1.amazonaws.com/stag"
echo ""
echo "Debugging tips:"
echo "  List ECS tasks:    aws ecs list-tasks --cluster cast-agent-cluster --profile cikada-stag"
echo "  Stop stale task:   aws ecs stop-task --cluster cast-agent-cluster --task <arn> --profile cikada-stag"
echo "  View task logs:    Check CloudWatch /ecs/cast-agent log group"
echo ""
