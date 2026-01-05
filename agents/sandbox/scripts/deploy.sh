#!/bin/bash
# Deploy Claude Code Fargate runtime
#
# This script:
# 1. Builds the TypeScript code
# 2. Builds the Docker container
# 3. Pushes to ECR
# 4. Deploys the SAM template
#
# Prerequisites:
# - AWS CLI configured with appropriate permissions
# - Docker installed and running
# - SAM CLI installed
#
# Required environment variables:
# - ANTHROPIC_API_KEY_SECRET_ARN: ARN of Secrets Manager secret with Anthropic API key
# - VPC_ID: VPC ID for Fargate tasks
# - SUBNET_IDS: Comma-separated private subnet IDs
# - CIKADA_API_URL: URL of the Cikada HTTP API (for Tymbal streaming)
#
# Optional:
# - AWS_REGION: AWS region (default: us-east-1)
# - STACK_NAME: CloudFormation stack name (default: cicada-fargate)
# - IMAGE_TAG: Docker image tag (default: latest)

set -e

# Configuration
AWS_REGION="${AWS_REGION:-us-east-1}"
STACK_NAME="${STACK_NAME:-cicada-fargate}"
ECR_REPO_NAME="${ECR_REPO_NAME:-claude-code}"
IMAGE_TAG="${IMAGE_TAG:-latest}"

# Get script directory
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PACKAGE_DIR="$(dirname "$SCRIPT_DIR")"

cd "$PACKAGE_DIR"

# Validate required environment variables
validate_env() {
    local missing=()

    [[ -z "$ANTHROPIC_API_KEY_SECRET_ARN" ]] && missing+=("ANTHROPIC_API_KEY_SECRET_ARN")
    [[ -z "$VPC_ID" ]] && missing+=("VPC_ID")
    [[ -z "$SUBNET_IDS" ]] && missing+=("SUBNET_IDS")
    [[ -z "$CIKADA_API_URL" ]] && missing+=("CIKADA_API_URL")

    if [[ ${#missing[@]} -gt 0 ]]; then
        echo "Error: Missing required environment variables:"
        printf '  - %s\n' "${missing[@]}"
        echo ""
        echo "Example:"
        echo "  export ANTHROPIC_API_KEY_SECRET_ARN=arn:aws:secretsmanager:us-east-1:123456789:secret:anthropic-api-key"
        echo "  export VPC_ID=vpc-12345678"
        echo "  export SUBNET_IDS=subnet-abc123,subnet-def456"
        echo "  export CIKADA_API_URL=https://xxx.execute-api.us-east-1.amazonaws.com/prod"
        exit 1
    fi
}

# Get AWS account ID
get_account_id() {
    aws sts get-caller-identity --query Account --output text
}

echo "=========================================="
echo "  Claude Code Fargate Deployment"
echo "=========================================="
echo ""

# Validate environment
echo "Validating environment..."
validate_env

AWS_ACCOUNT_ID=$(get_account_id)
ECR_URI="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com/${ECR_REPO_NAME}"

echo "  AWS Account: $AWS_ACCOUNT_ID"
echo "  AWS Region: $AWS_REGION"
echo "  Stack Name: $STACK_NAME"
echo "  ECR URI: $ECR_URI:$IMAGE_TAG"
echo "  VPC ID: $VPC_ID"
echo "  Subnet IDs: $SUBNET_IDS"
echo ""

# Step 1: Build TypeScript
echo "=========================================="
echo "  Step 1: Build TypeScript"
echo "=========================================="
npm run build
echo ""

# Step 2: Build Docker image
echo "=========================================="
echo "  Step 2: Build Docker Image"
echo "=========================================="
docker build -t "${ECR_REPO_NAME}:${IMAGE_TAG}" .
echo ""

# Step 3: Push to ECR
echo "=========================================="
echo "  Step 3: Push to ECR"
echo "=========================================="

# Create ECR repo if needed
echo "Ensuring ECR repository exists..."
aws ecr describe-repositories --repository-names "${ECR_REPO_NAME}" --region "${AWS_REGION}" 2>/dev/null || \
    aws ecr create-repository --repository-name "${ECR_REPO_NAME}" --region "${AWS_REGION}" \
        --image-scanning-configuration scanOnPush=true

# Login to ECR
echo "Logging in to ECR..."
aws ecr get-login-password --region "${AWS_REGION}" | \
    docker login --username AWS --password-stdin "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"

# Tag and push
echo "Tagging and pushing image..."
docker tag "${ECR_REPO_NAME}:${IMAGE_TAG}" "${ECR_URI}:${IMAGE_TAG}"
docker push "${ECR_URI}:${IMAGE_TAG}"
echo ""

# Step 4: SAM Deploy
echo "=========================================="
echo "  Step 4: SAM Deploy"
echo "=========================================="

sam deploy \
    --template-file template.yaml \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --capabilities CAPABILITY_IAM CAPABILITY_NAMED_IAM \
    --parameter-overrides \
        "AnthropicApiKeySecretArn=$ANTHROPIC_API_KEY_SECRET_ARN" \
        "CikadaApiUrl=$CIKADA_API_URL" \
        "VpcId=$VPC_ID" \
        "SubnetIds=$SUBNET_IDS" \
        "ContainerImage=${ECR_URI}:${IMAGE_TAG}" \
    --no-fail-on-empty-changeset

echo ""
echo "=========================================="
echo "  Deployment Complete!"
echo "=========================================="
echo ""

# Get outputs
echo "Stack Outputs:"
aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --region "$AWS_REGION" \
    --query 'Stacks[0].Outputs[*].[OutputKey,OutputValue]' \
    --output table

echo ""
echo "To use claude-code agent, set in aws-runtime:"
echo "  ORCHESTRATOR_FUNCTION_NAME=$(aws cloudformation describe-stacks \
    --stack-name "$STACK_NAME" \
    --query 'Stacks[0].Outputs[?OutputKey==`OrchestratorFunctionName`].OutputValue' \
    --output text)"
