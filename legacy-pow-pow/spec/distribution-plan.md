# Cast Distribution Plan

> Comprehensive plan for distributing Cast via `npx @sanity/cast` with minimal friction, Claude CLI verification, and configurable `--port`/`--database` options.
>
> **Version:** v2
> **Authors:** coordinator, alpha, beta, gamma
> **Date:** 2025-12-25

## Goal

Enable `npx @sanity/cast` to "just work" with:
- Minimal install friction
- Claude CLI verification with helpful guidance
- Configurable `--port` and `--database` options
- Smooth first-run experience

---

## 1. Package Configuration

### package.json Changes

```json
{
  "name": "@sanity/cast",
  "version": "1.0.0",
  "bin": {
    "cast": "./dist/cli.js"
  },
  "files": ["dist", "defaults"],
  "type": "module",
  "engines": {
    "node": ">=18.0.0"
  },
  "scripts": {
    "build": "tsc",
    "prepublishOnly": "npm run build"
  }
}
```

**Key changes:**
- `bin` points to compiled JS (`dist/cli.js`), not TypeScript
- `files` includes only `dist/` and `defaults/` (assets needed at runtime)
- `engines` enforces Node 18+ (for built-in `parseArgs`)
- `prepublishOnly` ensures build before publish

### Directory Structure (Published Package)

```
@sanity/cast/
├── dist/
│   ├── cli.js          # Entry point (compiled from src/cli.ts)
│   ├── index.js        # Main module
│   ├── server/
│   ├── client/
│   └── shared/
├── defaults/           # YAML formations, markdown hats/playbooks
└── package.json
```

---

## 2. CLI Entry Point

### New `src/cli.ts` (Wrapper)

```typescript
#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { runDoctor, checkPrerequisites } from './startup/validation.js';
import { startServer } from './server/index.js';
import { startClient } from './client/index.js';

const { values, positionals } = parseArgs({
  options: {
    port: { type: 'string', short: 'p', default: process.env.CAST_PORT || process.env.PORT || '3131' },
    database: { type: 'string', short: 'd', default: process.env.CAST_DATABASE || process.env.POWPOW_DB },
    doctor: { type: 'boolean', default: false },
    server: { type: 'boolean', default: false },
    client: { type: 'boolean', default: false },
    help: { type: 'boolean', short: 'h', default: false },
    version: { type: 'boolean', short: 'v', default: false },
  },
  allowPositionals: true,
});

if (values.help) {
  showHelp();
  process.exit(0);
}

if (values.doctor) {
  await runDoctor();
  process.exit(0);
}

// Check prerequisites before starting
const prereqResult = await checkPrerequisites({ verbose: false });
if (!prereqResult.ok) {
  console.error(prereqResult.message);
  console.error('\nRun `npx @sanity/cast --doctor` for detailed diagnostics.');
  process.exit(1);
}

// Start server/client based on flags
// ... existing logic from src/index.ts
```

### CLI Options

| Flag | Short | Env Var | Default | Description |
|------|-------|---------|---------|-------------|
| `--port` | `-p` | `CAST_PORT` (fallback: `PORT`) | `3131` | Server port |
| `--database` | `-d` | `CAST_DATABASE` (fallback: `POWPOW_DB`) | `~/.cast/cast.db` | Database path |
| `--doctor` | | | | Run diagnostics |
| `--server` | | | | Server-only mode |
| `--client` | | | | Client-only mode |
| `--help` | `-h` | | | Show help |
| `--version` | `-v` | | | Show version |
| `--transcript` | | `CAST_TRANSCRIPT` (fallback: `POWPOW_TRANSCRIPT`) | `false` | Log messages to files |
| `--vpn` | | | | Expose on VPN network (e.g., `--vpn tailscale`) |

---

## 3. Startup Validation

### Validation Sequence

```
1. Check Node.js version (>=18.0.0)
   └─ Fail: "Node.js 18+ required. You have: X.Y.Z"

2. Check native modules (better-sqlite3 loads successfully)
   └─ Fail: Show troubleshooting link (see Section 5 for error handling)

3. Check Claude CLI installed (`which claude`)
   └─ Fail: "Claude CLI not found. Install: npm install -g @anthropic-ai/claude-code"

4. Check Claude auth configured (~/.claude/ exists OR ANTHROPIC_API_KEY set)
   └─ Warn: "Claude may not be authenticated. Run: claude auth login"

5. Verify/create database directory
   └─ Fail: "Cannot create database directory: <path>"

6. Check port availability
   └─ Fail: "Port 3131 already in use. Try: npx @sanity/cast --port 3132"
```

### `--doctor` Output

```
Cast Doctor
───────────

✓ Node.js v20.10.0 (>=18.0.0 required)
✓ Native modules loaded (better-sqlite3)
✓ Claude CLI found (/usr/local/bin/claude)
⚠ Claude auth not verified (will check on first agent spawn)
✓ Database directory writable (~/.cast/)
✓ Port 3131 available

All checks passed! Run `npx @sanity/cast` to start.
```

### Exit Code Semantics

| Exit Code | Meaning | Use Case |
|-----------|---------|----------|
| `0` | All checks pass (warnings OK) | CI: `npx @sanity/cast --doctor && deploy` |
| `1` | Hard failures (missing Claude CLI, wrong Node, etc.) | Blocks startup/CI |

Warnings (like unverified auth) print to stderr but don't cause non-zero exit. This keeps `--doctor` composable with CI pipelines.

### New Dependency

```json
{
  "dependencies": {
    "command-exists": "^1.2.9"
  }
}
```

---

## 4. Build Process

### TypeScript Compilation

Update `tsconfig.json`:
```json
{
  "compilerOptions": {
    "outDir": "dist",
    "rootDir": "src",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "target": "ES2022",
    "declaration": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

### Build Script

```bash
# package.json scripts
"build": "tsc && chmod +x dist/cli.js",
"prepublishOnly": "npm run build"
```

### Remove tsx Runtime Dependency

- Delete `bin/powpow` bash script
- Remove `tsx` from dependencies (keep in devDependencies for local dev)
- Update any `npx tsx` references to use compiled output

---

## 5. Native Module Strategy

### better-sqlite3

**Approach:** Trust prebuilds, provide good error messaging

- Prebuilds cover: macOS (x64/arm64), Linux (x64/arm64), Windows (x64)
- No changes needed to dependency
- Add try/catch around import with helpful error:

```typescript
let Database;
try {
  Database = (await import('better-sqlite3')).default;
} catch (err) {
  console.error(`
❌ Failed to load SQLite module

This usually means prebuilt binaries aren't available for your platform.

Troubleshooting:
1. Ensure you have build tools installed:
   - macOS: xcode-select --install
   - Ubuntu: sudo apt install build-essential python3
   - Windows: npm install -g windows-build-tools

2. Try reinstalling: npm rebuild better-sqlite3

See: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md
`);
  process.exit(1);
}
```

---

## 6. Data Directory Changes

### Rebrand: `.powpow` → `.cast`

| Old | New | Env Var |
|-----|-----|---------|
| `~/.powpow/` | `~/.cast/` | `CAST_DIR` |
| `~/.powpow/powpow.db` | `~/.cast/cast.db` | `CAST_DATABASE` |
| `~/.powpow/config.json` | `~/.cast/config.json` | - |

### Migration

No automatic migration. Clean break to `~/.cast/`.

Users who want to keep using existing data can specify the old path:
```bash
npx @sanity/cast --database ~/.powpow/powpow.db
```

---

## 7. Defaults Directory Resolution

### Problem
Current code expects `defaults/` relative to working directory.

### Solution
Resolve relative to package installation:

```typescript
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DEFAULTS_DIR = join(__dirname, '..', 'defaults');
```

---

## 8. VPN Integration

### Purpose
Allow users to expose Cast on their VPN network for access from other devices. Supports Tailscale initially, extensible to other VPNs (ZeroTier, Nebula, etc.) in the future.

### CLI Flag

| Flag | Values | Description |
|------|--------|-------------|
| `--vpn` | `tailscale` | Expose on VPN network |

### Binding Behavior

```
Default (no flag):           127.0.0.1:3131  (localhost only)
--vpn tailscale:             0.0.0.0:3131   (all interfaces, show tailnet URL)
--port 4000:                 127.0.0.1:4000  (custom port, localhost)
--vpn tailscale --port 4000: 0.0.0.0:4000   (custom port, all interfaces)
```

### Detection & Startup Flow

```typescript
import commandExists from 'command-exists';
import { execSync } from 'child_process';

async function getTailscaleInfo() {
  // Check if tailscale CLI exists
  try {
    await commandExists('tailscale');
  } catch {
    return { installed: false };
  }

  // Check if connected and get info
  try {
    const ip = execSync('tailscale ip -4', { encoding: 'utf8' }).trim();
    const status = JSON.parse(execSync('tailscale status --json', { encoding: 'utf8' }));
    const hostname = status.Self?.DNSName?.replace(/\.$/, ''); // Remove trailing dot
    return { installed: true, connected: true, ip, hostname };
  } catch {
    return { installed: true, connected: false };
  }
}
```

### Startup Messages

**With `--vpn tailscale` (success):**
```
Cast running at:
  Local:    http://localhost:3131
  Tailnet:  http://your-machine.tail-net.ts.net:3131
```

**With `--vpn tailscale` (not installed):**
```
❌ Tailscale not found

The --vpn tailscale option requires Tailscale to be installed.
Install it from: https://tailscale.com/download

Or run without --vpn to bind to localhost only.
```

**With `--vpn tailscale` (not connected):**
```
❌ Tailscale not connected

Tailscale is installed but not connected to a tailnet.
Connect with: tailscale up

Or run without --vpn to bind to localhost only.
```

**With `--vpn <unknown>`:**
```
❌ Unknown VPN: zerotier

Supported VPNs: tailscale

Or run without --vpn to bind to localhost only.
```

### `--doctor` Integration

When `--vpn tailscale` is used OR Tailscale is detected:
```
✓ Tailscale installed (/usr/local/bin/tailscale)
✓ Tailscale connected (your-machine.tail-net.ts.net)
```

Or:
```
⚠ Tailscale installed but not connected
  → Run: tailscale up
```

Or (if not installed and --vpn not used):
```
· Tailscale not installed (optional)
```

---

## 9. Implementation Checklist

### Phase A: Build Infrastructure
- [ ] Create `src/cli.ts` entry point with `parseArgs`
- [ ] Update `tsconfig.json` for dist output
- [ ] Add build scripts to package.json
- [ ] Update `files` field to include dist + defaults
- [ ] Add `.npmrc` with `engine-strict=true`

### Phase B: Startup Validation
- [ ] Create `src/startup/validation.ts` module
- [ ] Implement Node version check
- [ ] Implement Claude CLI detection (`command-exists`)
- [ ] Implement Claude auth check (config file existence)
- [ ] Implement port availability check
- [ ] Implement `--doctor` command

### Phase C: CLI Arguments
- [ ] Add `--port` flag (with `CAST_PORT` env var)
- [ ] Add `--database` flag (with `CAST_DATABASE` env var)
- [ ] Add backward compat for `PORT` / `POWPOW_DB`
- [ ] Add `--help` with usage info

### Phase D: Path Resolution
- [ ] Update defaults directory resolution
- [ ] Update database path defaults
- [ ] Update config path defaults

### Phase E: VPN Support
- [ ] Create `src/startup/vpn.ts` module
- [ ] Implement Tailscale detection (`command-exists`)
- [ ] Implement Tailscale IP/hostname lookup
- [ ] Add `--vpn` flag with `tailscale` value support
- [ ] Update server binding logic for `0.0.0.0`
- [ ] Add VPN checks to `--doctor` output
- [ ] Add helpful error messages for missing/disconnected VPN

### Phase F: Polish
- [ ] Remove tsx runtime dependency
- [ ] Delete old bin/powpow bash script
- [ ] Add better-sqlite3 error handling
- [ ] Test on macOS, Linux, Windows
- [ ] Update README with new usage

---

## 10. Open Decisions

1. ~~**Migration from `.powpow/` to `.cast/`**~~: Resolved - clean break, no migration. Use `--database` for old path.
2. **Web client**: Include in npx distribution or separate package?
3. **Agent workspace location**: Rename `/tmp/powpow/` → `/tmp/cast/` for MVP. Future: make configurable via `--workspace` flag.

---

## 11. Success Criteria

After implementation:
```bash
# This should "just work"
npx @sanity/cast

# With options
npx @sanity/cast --port 4000 --database ./my.db

# With VPN
npx @sanity/cast --vpn tailscale

# Diagnostics
npx @sanity/cast --doctor
```

User sees helpful errors if:
- Node < 18
- Claude CLI not installed
- Claude not authenticated
- Port in use
- Database path not writable
- VPN not installed/connected (when `--vpn` used)
