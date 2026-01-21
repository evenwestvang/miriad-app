# GitHub Secrets Configuration

## Setup

1. Go to: https://github.com/simen/cast-app/settings/secrets/actions
2. Create environments: `staging` and `production`
3. Add secrets listed below

## AWS Credentials (Repository level)

| Secret | Description |
|--------|-------------|
| `AWS_ACCESS_KEY_ID` | IAM access key |
| `AWS_SECRET_ACCESS_KEY` | IAM secret key |
| `AWS_ACCOUNT_ID` | AWS account number |

## Staging Environment

| Secret | Description |
|--------|-------------|
| `STAGING_PLANETSCALE_URL` | Database connection string |
| `STAGING_ANTHROPIC_API_KEY` | Anthropic API key |
| `STAGING_JWT_SECRET` | JWT signing secret |
| `STAGING_SECRET_KEY` | Encryption key for OAuth tokens |
| `STAGING_WORKOS_API_KEY` | WorkOS API key |
| `STAGING_WORKOS_CLIENT_ID` | WorkOS client ID |
| `STAGING_GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `STAGING_GITHUB_CLIENT_SECRET` | GitHub OAuth secret |
| `STAGING_SUBNET_IDS` | Comma-separated subnet IDs |
| `STAGING_SECURITY_GROUP_IDS` | Security group IDs |
| `STAGING_FLY_API_TOKEN` | Fly.io API token for staging |
| `STAGING_FLY_APP_NAME` | Fly.io app name (e.g., cast-agent-staging) |
| `STAGING_TUNNEL_FLY_API_TOKEN` | Fly.io API token for staging tunnel server |
| `STAGING_CONTAINER_SECRET` | Container auth secret (must match tunnel server) |
| `VERCEL_TOKEN` | Vercel API token |

## Production Environment

Same pattern with `PROD_` prefix, plus:

| Secret | Description |
|--------|-------------|
| `PROD_PLANETSCALE_URL` | Database connection string |
| `PROD_ANTHROPIC_API_KEY` | Anthropic API key |
| `PROD_JWT_SECRET` | JWT signing secret |
| `PROD_SECRET_KEY` | Encryption key for OAuth tokens |
| `PROD_WORKOS_API_KEY` | WorkOS API key |
| `PROD_WORKOS_CLIENT_ID` | WorkOS client ID |
| `PROD_WORKOS_REDIRECT_URI` | Production OAuth redirect |
| `PROD_GITHUB_CLIENT_ID` | GitHub OAuth client ID |
| `PROD_GITHUB_CLIENT_SECRET` | GitHub OAuth secret |
| `PROD_FRONTEND_URL` | Production frontend URL |
| `PROD_CAST_API_URL` | Production API URL |
| `PROD_WS_URL` | Production WebSocket URL |
| `PROD_TUNNEL_SERVER_URL` | Production tunnel URL |
| `PROD_SUBNET_IDS` | Comma-separated subnet IDs |
| `PROD_SECURITY_GROUP_IDS` | Security group IDs |
| `PROD_VPC_ID` | AWS VPC ID (for tunnel server) |
| `PROD_CERT_ARN` | ACM certificate ARN (for tunnel server) |
| `PROD_HOSTED_ZONE_ID` | Route53 hosted zone ID (for tunnel server) |
| `PROD_CONTAINER_SECRET` | Container auth secret (must match tunnel server) |
| `PROD_FLY_API_TOKEN` | Fly.io API token for production |
| `PROD_FLY_APP_NAME` | Fly.io app name (e.g., cast-agent-prod) |
| `PROD_TUNNEL_FLY_API_TOKEN` | Fly.io API token for production tunnel server |

## Migration from samconfig.toml

1. Copy values to GitHub Secrets
2. Delete secrets from samconfig.toml
3. Keep only samconfig.toml.template in repo
4. **Rotate all exposed secrets**
