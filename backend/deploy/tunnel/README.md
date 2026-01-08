# Cast Tunnel Server Infrastructure

Deploys the rathole reverse proxy server for exposing agent container HTTP services.

## Architecture

```
Internet → Route53 (*.containers.clanker.is)
        → ALB (TLS termination, wildcard cert)
        → ECS Fargate (rathole server)
        ← Agent containers connect outbound
```

## Prerequisites

1. **ACM Certificate**: Request a wildcard certificate for `*.containers.clanker.is` in us-east-1
2. **Route53 Hosted Zone**: Must have hosted zone for `clanker.is`
3. **VPC**: Use same VPC as main CAST infrastructure
4. **Rathole Image**: Build and push to ECR (see below)

## Deployment

```bash
# Build rathole image (see agents/sandbox for Dockerfile additions)
docker build -t cast-tunnel .
docker push 455626925815.dkr.ecr.us-east-1.amazonaws.com/cast-tunnel:latest

# Deploy to staging
cd backend/deploy/tunnel
sam deploy --config-env tunnel-stag --template-file template.yaml
```

## Configuration

Update `samconfig.toml` with:
- `VpcId`: VPC ID from main CAST stack
- `SubnetIds`: Public subnets with internet access
- `CertificateArn`: ACM wildcard cert ARN
- `HostedZoneId`: Route53 zone ID for clanker.is
- `ContainerSecret`: Same secret used by main CAST deployment

## How It Works

1. Agent container starts with `TUNNEL_HASH` env var
2. Container connects outbound to tunnel server
3. Server validates container token, maps hash to connection
4. Traffic to `{hash}.containers.clanker.is` routes to container
5. Container can bind any port on 0.0.0.0 to expose it

## Security

- **URL-as-auth**: 32+ char unguessable hash in URL
- **TLS**: All traffic encrypted via ALB
- **Token validation**: Container auth uses existing CAST_AUTH_TOKEN protocol
- **Isolation**: Each container can only claim its assigned hash
