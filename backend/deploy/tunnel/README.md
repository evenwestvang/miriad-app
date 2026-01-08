# Cast Tunnel Server Infrastructure

Deploys the rathole reverse proxy server for exposing agent container HTTP services.

## Architecture

```
Internet → Route53 (*.staging.cast-stack.site)
        → ALB (TLS termination, wildcard cert)
        → ECS Fargate (rathole server + Hono proxy)
        ← Agent containers connect outbound
```

## Prerequisites

1. **AWS CLI**: Configured with `cikada-stag` profile for account `455626925815`
2. **Docker**: Installed and running
3. **ECR Repository**: `cast-tunnel-server` (created automatically by deploy script)

## Deployment

```bash
# From the repo root:
./scripts/deploy-tunnel.sh stag    # Deploy to staging
./scripts/deploy-tunnel.sh prod    # Deploy to production
```

The script will:
1. Build the Docker image for linux/arm64
2. Push to ECR with timestamped tag
3. Deploy/update CloudFormation stack
4. Output health check URL

## AWS Configuration

**Staging (account 455626925815):**
- Profile: `cikada-stag`
- Domain: `*.staging.cast-stack.site`
- VPC: Auto-discovered (or set `VPC_ID` env var)
- Subnets: Auto-discovered (or set `SUBNET_IDS` env var)
- Hosted Zone: Auto-discovered for `cast-stack.site`

**Production:**
- Profile: `cikada-prod`
- Domain: `*.cast-stack.site`
- Requires `PROD_CERT_ARN` and `CONTAINER_SECRET` env vars

## Manual Override

If auto-discovery fails, set environment variables:
```bash
export VPC_ID=vpc-0cddcd4252755eb3d
export SUBNET_IDS=subnet-0873ce7dc641901f6,subnet-0ecf88ad31694eb5e
export HOSTED_ZONE_ID=Z09693013171B0WCJNAMI
./scripts/deploy-tunnel.sh stag  # Run from repo root
```

## Verification

```bash
# Health check
curl https://tunnel.staging.cast-stack.site/health

# Should return: {"status":"healthy","service":"cast-tunnel-server","clients":N}
```

## How It Works

1. Agent container starts with `TUNNEL_HASH` env var
2. Container runs rathole client, connects outbound to tunnel server
3. Server validates container token via existing CAST_AUTH_TOKEN protocol
4. Traffic to `{hash}.staging.cast-stack.site` routes through rathole to container
5. Container services bind to localhost, rathole forwards traffic

## Security

- **URL-as-auth**: 32+ char unguessable hash in URL
- **TLS**: All traffic encrypted via ALB
- **Token validation**: Container auth uses existing CAST_AUTH_TOKEN protocol
- **Isolation**: Each container can only claim its assigned hash
