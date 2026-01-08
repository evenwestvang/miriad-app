#!/bin/bash
#
# Deploy Cast Tunnel Server
#
# This script builds, pushes, and deploys the tunnel server infrastructure.
# The tunnel server enables HTTP access to agent containers via rathole reverse proxy.
#
# Usage:
#   ./scripts/deploy-tunnel.sh <stage>
#
# Examples:
#   ./scripts/deploy-tunnel.sh stag    # Deploy to staging
#   ./scripts/deploy-tunnel.sh prod    # Deploy to production
#
# Prerequisites:
#   - AWS CLI configured with appropriate credentials
#   - Docker installed and running
#   - ECR repository created (cast-tunnel-server)
#
# Environment variables (or will prompt):
#   AWS_ACCOUNT_ID      - AWS account ID
#   AWS_REGION          - AWS region (default: us-east-1)
#   VPC_ID              - VPC ID for deployment
#   SUBNET_IDS          - Comma-separated subnet IDs
#   HOSTED_ZONE_ID      - Route53 hosted zone ID
#   CONTAINER_SECRET    - CAST_CONTAINER_SECRET value
#

set -euo pipefail

# =============================================================================
# Configuration
# =============================================================================

STAGE="${1:-}"
if [[ -z "$STAGE" ]]; then
  echo "Usage: $0 <stage>"
  echo "  stage: stag or prod"
  exit 1
fi

if [[ "$STAGE" != "stag" && "$STAGE" != "prod" ]]; then
  echo "Error: stage must be 'stag' or 'prod'"
  exit 1
fi

# Set domain based on stage
if [[ "$STAGE" == "stag" ]]; then
  TUNNEL_DOMAIN="staging.cast-stack.site"
  CERT_ARN="arn:aws:acm:us-east-1:455626925815:certificate/8f78b02a-b50d-462a-8cb1-4094ee3cefd1"
else
  TUNNEL_DOMAIN="cast-stack.site"
  CERT_ARN="${PROD_CERT_ARN:-}"  # Set this for production
fi

AWS_REGION="${AWS_REGION:-us-east-1}"
AWS_ACCOUNT_ID="${AWS_ACCOUNT_ID:-}"
ECR_REPO="cast-tunnel-server"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# =============================================================================
# Validation
# =============================================================================

echo "=== Cast Tunnel Server Deployment ==="
echo "Stage: $STAGE"
echo "Domain: *.$TUNNEL_DOMAIN"
echo ""

# Check required tools
command -v aws >/dev/null 2>&1 || { echo "Error: aws CLI not found"; exit 1; }
command -v docker >/dev/null 2>&1 || { echo "Error: docker not found"; exit 1; }

# Get AWS account ID if not set
if [[ -z "$AWS_ACCOUNT_ID" ]]; then
  AWS_ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
fi

echo "AWS Account: $AWS_ACCOUNT_ID"
echo "AWS Region: $AWS_REGION"
echo ""

# Prompt for missing config
if [[ -z "${VPC_ID:-}" ]]; then
  read -p "VPC ID: " VPC_ID
fi

if [[ -z "${SUBNET_IDS:-}" ]]; then
  read -p "Subnet IDs (comma-separated): " SUBNET_IDS
fi

if [[ -z "${HOSTED_ZONE_ID:-}" ]]; then
  read -p "Route53 Hosted Zone ID: " HOSTED_ZONE_ID
fi

if [[ -z "${CONTAINER_SECRET:-}" ]]; then
  read -s -p "Container Secret (CAST_CONTAINER_SECRET): " CONTAINER_SECRET
  echo ""
fi

# =============================================================================
# Step 1: Build Docker Image
# =============================================================================

echo ""
echo "=== Step 1: Building Docker Image ==="

ECR_URI="$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com/$ECR_REPO"
IMAGE_TAG="$STAGE-$(date +%Y%m%d-%H%M%S)"

cd "$PROJECT_ROOT/packages/tunnel-server"

docker build \
  --platform linux/arm64 \
  -t "$ECR_REPO:$IMAGE_TAG" \
  -t "$ECR_REPO:$STAGE-latest" \
  .

echo "Built: $ECR_REPO:$IMAGE_TAG"

# =============================================================================
# Step 2: Push to ECR
# =============================================================================

echo ""
echo "=== Step 2: Pushing to ECR ==="

# Login to ECR
aws ecr get-login-password --region "$AWS_REGION" | \
  docker login --username AWS --password-stdin "$AWS_ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com"

# Create repo if it doesn't exist
aws ecr describe-repositories --repository-names "$ECR_REPO" --region "$AWS_REGION" >/dev/null 2>&1 || \
  aws ecr create-repository --repository-name "$ECR_REPO" --region "$AWS_REGION"

# Tag and push
docker tag "$ECR_REPO:$IMAGE_TAG" "$ECR_URI:$IMAGE_TAG"
docker tag "$ECR_REPO:$STAGE-latest" "$ECR_URI:$STAGE-latest"

docker push "$ECR_URI:$IMAGE_TAG"
docker push "$ECR_URI:$STAGE-latest"

echo "Pushed: $ECR_URI:$IMAGE_TAG"

# =============================================================================
# Step 3: Deploy CloudFormation Stack
# =============================================================================

echo ""
echo "=== Step 3: Deploying CloudFormation Stack ==="

STACK_NAME="cast-tunnel-$STAGE"

cd "$PROJECT_ROOT"

aws cloudformation deploy \
  --template-file deploy/tunnel/template.yaml \
  --stack-name "$STACK_NAME" \
  --parameter-overrides \
    Stage="$STAGE" \
    VpcId="$VPC_ID" \
    SubnetIds="$SUBNET_IDS" \
    CertificateArn="$CERT_ARN" \
    HostedZoneId="$HOSTED_ZONE_ID" \
    TunnelDomain="$TUNNEL_DOMAIN" \
    ContainerSecret="$CONTAINER_SECRET" \
    RatholeImage="$ECR_URI:$IMAGE_TAG" \
  --capabilities CAPABILITY_NAMED_IAM \
  --region "$AWS_REGION"

# =============================================================================
# Step 4: Verify Deployment
# =============================================================================

echo ""
echo "=== Step 4: Verifying Deployment ==="

# Get stack outputs
ALB_DNS=$(aws cloudformation describe-stacks \
  --stack-name "$STACK_NAME" \
  --query "Stacks[0].Outputs[?OutputKey=='TunnelAlbDnsName'].OutputValue" \
  --output text \
  --region "$AWS_REGION")

echo ""
echo "=== Deployment Complete ==="
echo ""
echo "Stack: $STACK_NAME"
echo "ALB DNS: $ALB_DNS"
echo "Tunnel Domain: *.$TUNNEL_DOMAIN"
echo ""
echo "Test health check:"
echo "  curl https://health.$TUNNEL_DOMAIN/health"
echo ""
echo "Set TUNNEL_SERVER_URL in your environment:"
echo "  export TUNNEL_SERVER_URL=https://tunnel.$TUNNEL_DOMAIN"
echo ""
