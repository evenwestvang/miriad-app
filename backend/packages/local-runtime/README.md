# @miriad-systems/backend

Run Miriad agents on your local machine, container, or VPS.

## Installation

No installation required - use npx to run directly:

```bash
npx @miriad-systems/backend help
```

## Quick Start

### 1. Authenticate

Get a connection string from the Miriad UI (Settings > Runtimes > Connect Local Runtime), then run:

```bash
npx @miriad-systems/backend auth "cast://bst_xxx@api.miriad.systems/space_abc"
```

### 2. Set your API key

```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### 3. Start the runtime

```bash
npx @miriad-systems/backend start
```

The runtime will connect to Miriad and wait for agent tasks.

## Commands

| Command | Description |
|---------|-------------|
| `auth <connection-string>` | Authenticate with Miriad using a connection string |
| `start [--name <name>]` | Start the runtime and connect to Miriad |
| `status` | Show runtime configuration and connection status |
| `agents` | List active agents on this runtime |
| `help` | Show help message |

## Configuration

- **Config file:** `~/.config/miriad/config.json`
- **Agent workspaces:** `~/miriad-workspaces/`

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `ANTHROPIC_API_KEY` | Yes | Your Anthropic API key for Claude |

## Running on a VPS or Container

The backend works the same way on any environment:

```bash
# On your VPS or in a container
export ANTHROPIC_API_KEY=sk-ant-...
npx @miriad-systems/backend auth "cast://..."
npx @miriad-systems/backend start --name my-vps
```

Use `--name` to give this runtime a recognizable name in the Miriad UI.

