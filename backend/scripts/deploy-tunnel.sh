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
# Environment variables (optional - auto-discovered if not set):
#   AWS_ACCOUNT_ID      - AWS account ID (auto-detected from credentials)
#   AWS_REGION          - AWS region (default: us-east-1)
#   VPC_ID              - VPC ID (auto-discovered by tag: cast-{stage}-vpc or Environment tag)
#   SUBNET_IDS          - Comma-separated subnet IDs (auto-discovered from VPC)
#   HOSTED_ZONE_ID      - Route53 hosted zone ID (auto-discovered for cast-stack.site)
#   CONTAINER_SECRET    - CAST_CONTAINER_SECRET value (will prompt if not set)
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

# Set domain and AWS profile based on stage
if [[ "$STAGE" == "stag" ]]; then
  TUNNEL_DOMAIN="staging.cast-stack.site"
  CERT_ARN="arn:aws:acm:us-east-1:455626925815:certificate/8f78b02a-b50d-462a-8cb1-4094ee3cefd1"
  AWS_PROFILE="${AWS_PROFILE:-cikada-stag}"
else
  TUNNEL_DOMAIN="cast-stack.site"
  CERT_ARN="${PROD_CERT_ARN:-}"  # Set this for production
  AWS_PROFILE="${AWS_PROFILE:-cikada-prod}"
fi

export AWS_PROFILE
echo "AWS Profile: $AWS_PROFILE"

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

# =============================================================================
# VPC Auto-Discovery
# =============================================================================

# Try to discover VPC if not explicitly set
if [[ -z "${VPC_ID:-}" ]]; then
  echo "Discovering VPC..."

  # First, check if there's only one VPC in the account (common case)
  VPC_COUNT=$(aws ec2 describe-vpcs \
    --query 'length(Vpcs)' \
    --output text \
    --region "$AWS_REGION" 2>/dev/null || echo "0")

  if [[ "$VPC_COUNT" == "1" ]]; then
    # Only one VPC exists - use it automatically
    VPC_ID=$(aws ec2 describe-vpcs \
      --query 'Vpcs[0].VpcId' \
      --output text \
      --region "$AWS_REGION")
    echo "Found single VPC: $VPC_ID (auto-selected)"
  else
    # Multiple VPCs - try tag-based discovery
    # Try finding VPC by Name tag pattern: cast-{stage}-vpc or cast-{stage}
    VPC_ID=$(aws ec2 describe-vpcs \
      --filters "Name=tag:Name,Values=cast-${STAGE}-vpc,cast-${STAGE}" \
      --query 'Vpcs[0].VpcId' \
      --output text \
      --region "$AWS_REGION" 2>/dev/null || echo "None")

    # If not found, try Environment tag
    if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
      VPC_ID=$(aws ec2 describe-vpcs \
        --filters "Name=tag:Environment,Values=${STAGE},staging,production" \
        --query 'Vpcs[0].VpcId' \
        --output text \
        --region "$AWS_REGION" 2>/dev/null || echo "None")
    fi

    # If still not found, list available VPCs and fail
    if [[ "$VPC_ID" == "None" || -z "$VPC_ID" ]]; then
      echo ""
      echo "Error: Could not auto-discover VPC for stage '$STAGE'"
      echo "Found $VPC_COUNT VPCs but none matched expected tags."
      echo ""
      echo "Available VPCs:"
      aws ec2 describe-vpcs \
        --query 'Vpcs[*].[VpcId,Tags[?Key==`Name`].Value|[0]]' \
        --output table \
        --region "$AWS_REGION"
      echo ""
      echo "Set VPC_ID environment variable and re-run:"
      echo "  export VPC_ID=vpc-xxxxx"
      echo "  $0 $STAGE"
      exit 1
    fi

    echo "Found VPC: $VPC_ID (matched by tag)"
  fi
fi

# Try to discover subnets if not explicitly set
if [[ -z "${SUBNET_IDS:-}" ]]; then
  echo "Discovering subnets..."

  # Get public subnets (those with MapPublicIpOnLaunch or route to IGW)
  # For simplicity, get first 2 subnets in different AZs
  SUBNETS=$(aws ec2 describe-subnets \
    --filters "Name=vpc-id,Values=${VPC_ID}" \
    --query 'Subnets[?MapPublicIpOnLaunch==`true`].[SubnetId]' \
    --output text \
    --region "$AWS_REGION" 2>/dev/null | head -2 | tr '\n' ',' | sed 's/,$//')

  # If no public subnets found, try all subnets
  if [[ -z "$SUBNETS" ]]; then
    SUBNETS=$(aws ec2 describe-subnets \
      --filters "Name=vpc-id,Values=${VPC_ID}" \
      --query 'Subnets[*].SubnetId' \
      --output text \
      --region "$AWS_REGION" 2>/dev/null | head -2 | tr '\n' ',' | sed 's/,$//')
  fi

  if [[ -z "$SUBNETS" ]]; then
    echo ""
    echo "Error: Could not find subnets for VPC $VPC_ID"
    echo ""
    echo "Available subnets:"
    aws ec2 describe-subnets \
      --filters "Name=vpc-id,Values=${VPC_ID}" \
      --query 'Subnets[*].[SubnetId,AvailabilityZone,MapPublicIpOnLaunch]' \
      --output table \
      --region "$AWS_REGION"
    echo ""
    echo "Set SUBNET_IDS environment variable and re-run:"
    echo "  export SUBNET_IDS=subnet-aaa,subnet-bbb"
    echo "  $0 $STAGE"
    exit 1
  fi

  SUBNET_IDS="$SUBNETS"
  echo "Found subnets: $SUBNET_IDS"
fi

# Try to discover hosted zone if not explicitly set
if [[ -z "${HOSTED_ZONE_ID:-}" ]]; then
  echo "Discovering hosted zone..."

  # Look for hosted zone matching the domain
  ZONE_DOMAIN="cast-stack.site."
  HOSTED_ZONE_ID=$(aws route53 list-hosted-zones \
    --query "HostedZones[?Name=='${ZONE_DOMAIN}'].Id" \
    --output text \
    --region "$AWS_REGION" 2>/dev/null | sed 's|/hostedzone/||')

  if [[ -z "$HOSTED_ZONE_ID" ]]; then
    echo ""
    echo "Error: Could not find hosted zone for $ZONE_DOMAIN"
    echo ""
    echo "Available hosted zones:"
    aws route53 list-hosted-zones \
      --query 'HostedZones[*].[Id,Name]' \
      --output table
    echo ""
    echo "Set HOSTED_ZONE_ID environment variable and re-run:"
    echo "  export HOSTED_ZONE_ID=Z1234567890"
    echo "  $0 $STAGE"
    exit 1
  fi

  echo "Found hosted zone: $HOSTED_ZONE_ID"
fi

echo ""
echo "VPC: $VPC_ID"
echo "Subnets: $SUBNET_IDS"
echo "Hosted Zone: $HOSTED_ZONE_ID"
echo ""

# Container secret handling
# For staging: use the dev fallback secret (matches main backend behavior)
# For production: require explicit secret (TODO: add SSM/Secrets Manager lookup)

if [[ -z "${CONTAINER_SECRET:-}" ]]; then
  if [[ "$STAGE" == "stag" ]]; then
    # Use dev fallback - matches docker-orchestrator.ts fallback
    CONTAINER_SECRET="cast-dev-container-secret-do-not-use-in-production"
    echo "Using dev fallback secret for staging"
  else
    # Production requires explicit secret
    echo "Error: CONTAINER_SECRET is required for production deployment"
    echo ""
    echo "Set CONTAINER_SECRET environment variable:"
    echo "  export CONTAINER_SECRET=your-production-secret"
    echo "  $0 $STAGE"
    echo ""
    echo "TODO: Add SSM/Secrets Manager auto-discovery for production"
    exit 1
  fi
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
