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
#   ./scripts/deploy-staging.sh              # Deploy both container and backend
#   ./scripts/deploy-staging.sh --backend    # Deploy backend only
#   ./scripts/deploy-staging.sh --container  # Deploy container only
#   ./scripts/deploy-staging.sh --force      # Force rebuild even if up-to-date

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"

# Configuration
AWS_REGION="us-east-1"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-455626925815}"
AWS_PROFILE="${AWS_PROFILE:-cikada-stag}"
export AWS_PROFILE

ECR_REPO_NAME="cast-agent"
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

# Parse arguments
DEPLOY_CONTAINER=true
DEPLOY_BACKEND=true
FORCE_BUILD=false

for arg in "$@"; do
    case $arg in
        --backend)
            DEPLOY_CONTAINER=false
            ;;
        --container)
            DEPLOY_BACKEND=false
            ;;
        --force)
            FORCE_BUILD=true
            ;;
    esac
done

# =============================================================================
# Container Image Build + Push
# =============================================================================

# Check if container needs rebuild by comparing git SHA
check_container_needs_build() {
    local git_sha
    git_sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)

    echo "Checking if container needs rebuild..."
    echo "  Local git SHA: ${git_sha}"

    # Try to get the deployed image's git SHA label
    local deployed_sha
    deployed_sha=$(aws ecr describe-images \
        --repository-name "${ECR_REPO_NAME}" \
        --image-ids imageTag=latest \
        --query 'imageDetails[0].imageTags' \
        --output text \
        --region "${AWS_REGION}" 2>/dev/null | tr '\t' '\n' | grep "^sha-" | sed 's/^sha-//' || echo "")

    if [[ -n "$deployed_sha" ]]; then
        echo "  Deployed git SHA: ${deployed_sha}"
        if [[ "$git_sha" == "$deployed_sha" ]]; then
            echo "  Container is up-to-date (SHA match)"
            return 1  # No build needed
        else
            echo "  Container needs rebuild (SHA mismatch)"
            return 0  # Build needed
        fi
    else
        echo "  No deployed image found or no SHA tag"
        return 0  # Build needed
    fi
}

deploy_container() {
    local git_sha
    git_sha=$(git -C "$REPO_ROOT" rev-parse --short HEAD)
    local timestamp
    timestamp=$(date +%Y%m%d-%H%M%S)
    local image_tag="stag-${timestamp}"

    echo "=============================================="
    echo "Building and pushing agent container to ECR"
    echo "=============================================="
    echo "  AWS Profile: ${AWS_PROFILE}"
    echo "  ECR Repository: ${ECR_REPO_NAME}"
    echo "  Image Tag: ${image_tag}"
    echo "  Git SHA: ${git_sha}"
    echo "  Full URI: ${ECR_URI}:${image_tag}"
    echo ""

    # Check if rebuild is needed (unless --force)
    if [[ "$FORCE_BUILD" != "true" ]]; then
        if ! check_container_needs_build; then
            echo ""
            echo "Skipping container build (already up-to-date)"
            echo "Use --force to rebuild anyway"
            return 0
        fi
    else
        echo "Force build requested, skipping up-to-date check"
    fi

    echo ""

    cd "$REPO_ROOT/agents/sandbox"

    # Build TypeScript
    echo "Building TypeScript..."
    npm run build

    # Login to ECR
    echo "Logging in to ECR..."
    aws ecr get-login-password --region "${AWS_REGION}" | \
        docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

    # Ensure ECR repo exists
    aws ecr describe-repositories --repository-names "${ECR_REPO_NAME}" --region "${AWS_REGION}" >/dev/null 2>&1 || \
        aws ecr create-repository --repository-name "${ECR_REPO_NAME}" --region "${AWS_REGION}"

    # Build the image (ARM64 for Fargate Graviton)
    echo "Building Docker image (ARM64)..."
    docker build --platform linux/arm64 \
        -t "${ECR_REPO_NAME}:${image_tag}" \
        -t "${ECR_REPO_NAME}:latest" \
        -t "${ECR_REPO_NAME}:sha-${git_sha}" \
        .

    # Tag for ECR
    echo "Tagging image for ECR..."
    docker tag "${ECR_REPO_NAME}:${image_tag}" "${ECR_URI}:${image_tag}"
    docker tag "${ECR_REPO_NAME}:latest" "${ECR_URI}:latest"
    docker tag "${ECR_REPO_NAME}:sha-${git_sha}" "${ECR_URI}:sha-${git_sha}"

    # Push to ECR (all tags)
    echo "Pushing image to ECR..."
    docker push "${ECR_URI}:${image_tag}"
    docker push "${ECR_URI}:latest"
    docker push "${ECR_URI}:sha-${git_sha}"

    echo ""
    echo "Container deployed: ${ECR_URI}:${image_tag}"
    echo "  Also tagged as: latest, sha-${git_sha}"
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
echo "AWS Profile: ${AWS_PROFILE}"
echo "AWS Account: ${AWS_ACCOUNT_ID}"
echo "AWS Region: ${AWS_REGION}"
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
