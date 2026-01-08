#!/bin/bash
# Build and push CAST agent container to ECR
#
# This script:
# 1. Builds TypeScript code
# 2. Builds Docker image (ARM64 for Fargate)
# 3. Pushes to ECR
#
# Usage:
#   ./scripts/ecr-push.sh [tag]
#
# Examples:
#   ./scripts/ecr-push.sh          # Push with :latest tag
#   ./scripts/ecr-push.sh v1.2.3   # Push with specific tag

set -e

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
ECR_REPO_NAME="${ECR_REPO_NAME:-cast-agent}"
IMAGE_TAG="${1:-latest}"

ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "=========================================="
echo "  CAST Agent Container Build & Push"
echo "=========================================="
echo ""
echo "  AWS Account: ${AWS_ACCOUNT_ID}"
echo "  AWS Region: ${AWS_REGION}"
echo "  ECR Repository: ${ECR_REPO_NAME}"
echo "  Image Tag: ${IMAGE_TAG}"
echo "  Full URI: ${ECR_URI}:${IMAGE_TAG}"
echo ""

# Get script directory (to find Dockerfile)
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PACKAGE_DIR"

# Step 1: Build TypeScript
echo "=========================================="
echo "  Step 1: Build TypeScript"
echo "=========================================="
if [ -f "package.json" ]; then
    # Check if we have pnpm or npm
    if command -v pnpm &> /dev/null; then
        pnpm build
    else
        npm run build
    fi
else
    echo "No package.json found, skipping TypeScript build"
fi
echo ""

# Step 2: Create ECR repository if it doesn't exist
echo "=========================================="
echo "  Step 2: Ensure ECR Repository"
echo "=========================================="
aws ecr describe-repositories --repository-names "${ECR_REPO_NAME}" --region "${AWS_REGION}" 2>/dev/null || \
    aws ecr create-repository --repository-name "${ECR_REPO_NAME}" --region "${AWS_REGION}" \
        --image-scanning-configuration scanOnPush=true
echo ""

# Step 3: Login to ECR
echo "=========================================="
echo "  Step 3: ECR Login"
echo "=========================================="
aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
echo ""

# Step 4: Build the image (ARM64 for Fargate Graviton)
echo "=========================================="
echo "  Step 4: Build Docker Image (ARM64)"
echo "=========================================="
docker build --platform linux/arm64 -t "${ECR_REPO_NAME}:${IMAGE_TAG}" .
echo ""

# Step 5: Tag for ECR
echo "=========================================="
echo "  Step 5: Tag Image"
echo "=========================================="
docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"
echo ""

# Step 6: Push to ECR
echo "=========================================="
echo "  Step 6: Push to ECR"
echo "=========================================="
docker push "${ECR_URI}:${IMAGE_TAG}"

echo ""
echo "=========================================="
echo "  Done!"
echo "=========================================="
echo ""
echo "Image pushed to: ${ECR_URI}:${IMAGE_TAG}"
echo ""
echo "New containers will automatically use this image."
