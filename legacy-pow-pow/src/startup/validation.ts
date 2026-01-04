/**
 * Cast startup validation module
 *
 * Validates prerequisites before starting the server:
 * - Node.js version
 * - Native modules (better-sqlite3)
 * - Claude CLI installation
 * - Claude authentication
 * - Database directory
 * - Port availability
 */

import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';
import net from 'net';

export interface CheckResult {
  ok: boolean;
  message?: string;
}

export interface DoctorCheckResult {
  name: string;
  status: 'pass' | 'warn' | 'fail';
  message: string;
  detail?: string;
}

interface PrerequisiteOptions {
  verbose?: boolean;
  port?: number;
  databasePath?: string;
}

const REQUIRED_NODE_VERSION = '18.0.0';
const DEFAULT_PORT = 3131;
const DEFAULT_CAST_DIR = path.join(os.homedir(), '.cast');
const DEFAULT_DATABASE_PATH = path.join(DEFAULT_CAST_DIR, 'cast.db');

/**
 * Compare two semver version strings
 * Returns: negative if a < b, 0 if equal, positive if a > b
 */
function compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
    const numA = partsA[i] || 0;
    const numB = partsB[i] || 0;
    if (numA !== numB) return numA - numB;
  }
  return 0;
}

/**
 * Check if Node.js version meets minimum requirement
 */
function checkNodeVersion(): DoctorCheckResult {
  const currentVersion = process.version.replace(/^v/, '');
  const meetsRequirement = compareVersions(currentVersion, REQUIRED_NODE_VERSION) >= 0;

  return {
    name: 'Node.js version',
    status: meetsRequirement ? 'pass' : 'fail',
    message: meetsRequirement
      ? `Node.js v${currentVersion} (>=${REQUIRED_NODE_VERSION} required)`
      : `Node.js ${REQUIRED_NODE_VERSION}+ required. You have: v${currentVersion}`,
  };
}

/**
 * Check if better-sqlite3 native module loads successfully
 */
async function checkSqliteModule(): Promise<DoctorCheckResult> {
  try {
    await import('better-sqlite3');
    return {
      name: 'Native modules',
      status: 'pass',
      message: 'Native modules loaded (better-sqlite3)',
    };
  } catch (err) {
    return {
      name: 'Native modules',
      status: 'fail',
      message: 'Failed to load SQLite module',
      detail: `This usually means prebuilt binaries aren't available for your platform.

Troubleshooting:
1. Ensure you have build tools installed:
   - macOS: xcode-select --install
   - Ubuntu: sudo apt install build-essential python3
   - Windows: npm install -g windows-build-tools

2. Try reinstalling: npm rebuild better-sqlite3

See: https://github.com/WiseLibs/better-sqlite3/blob/master/docs/troubleshooting.md`,
    };
  }
}

/**
 * Check if Claude CLI is installed
 */
function checkClaudeCli(): DoctorCheckResult {
  try {
    const claudePath = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    return {
      name: 'Claude CLI',
      status: 'pass',
      message: `Claude CLI found (${claudePath})`,
    };
  } catch {
    return {
      name: 'Claude CLI',
      status: 'fail',
      message: 'Claude CLI not found',
      detail: 'Install: npm install -g @anthropic-ai/claude-code',
    };
  }
}

/**
 * Check if Claude authentication is configured
 */
function checkClaudeAuth(): DoctorCheckResult {
  const claudeConfigDir = path.join(os.homedir(), '.claude');
  const hasConfigDir = fs.existsSync(claudeConfigDir);
  const hasApiKey = !!process.env.ANTHROPIC_API_KEY;

  if (hasConfigDir || hasApiKey) {
    if (hasApiKey) {
      return {
        name: 'Claude auth',
        status: 'pass',
        message: 'Claude auth configured (ANTHROPIC_API_KEY set)',
      };
    }
    return {
      name: 'Claude auth',
      status: 'warn',
      message: 'Claude auth not verified (will check on first agent spawn)',
      detail: 'Run: claude auth login',
    };
  }

  return {
    name: 'Claude auth',
    status: 'warn',
    message: 'Claude may not be authenticated',
    detail: 'Run: claude auth login',
  };
}

/**
 * Check if database directory is writable
 */
function checkDatabaseDir(databasePath: string = DEFAULT_DATABASE_PATH): DoctorCheckResult {
  const dir = path.dirname(databasePath);

  try {
    // Create directory if it doesn't exist
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    // Test write access by creating and removing a temp file
    const testFile = path.join(dir, `.cast-test-${Date.now()}`);
    fs.writeFileSync(testFile, '');
    fs.unlinkSync(testFile);

    return {
      name: 'Database directory',
      status: 'pass',
      message: `Database directory writable (${dir.replace(os.homedir(), '~')})`,
    };
  } catch (err) {
    return {
      name: 'Database directory',
      status: 'fail',
      message: `Cannot create database directory: ${dir}`,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Check if port is available
 */
function checkPortAvailable(port: number = DEFAULT_PORT): Promise<DoctorCheckResult> {
  return new Promise((resolve) => {
    const server = net.createServer();

    server.once('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        resolve({
          name: 'Port availability',
          status: 'fail',
          message: `Port ${port} already in use`,
          detail: `Try: npx @sanity/cast --port ${port + 1}`,
        });
      } else {
        resolve({
          name: 'Port availability',
          status: 'fail',
          message: `Cannot check port ${port}`,
          detail: err.message,
        });
      }
    });

    server.once('listening', () => {
      server.close(() => {
        resolve({
          name: 'Port availability',
          status: 'pass',
          message: `Port ${port} available`,
        });
      });
    });

    server.listen(port, '127.0.0.1');
  });
}

/**
 * Run all checks and return summary result
 * Used before server startup to catch issues early
 */
export async function checkPrerequisites(options: PrerequisiteOptions = {}): Promise<CheckResult> {
  const { port = DEFAULT_PORT, databasePath = DEFAULT_DATABASE_PATH } = options;

  // Check Node version (hard fail)
  const nodeCheck = checkNodeVersion();
  if (nodeCheck.status === 'fail') {
    return { ok: false, message: nodeCheck.message };
  }

  // Check SQLite module (hard fail)
  const sqliteCheck = await checkSqliteModule();
  if (sqliteCheck.status === 'fail') {
    return { ok: false, message: `${sqliteCheck.message}\n\n${sqliteCheck.detail || ''}` };
  }

  // Check Claude CLI (hard fail)
  const claudeCheck = checkClaudeCli();
  if (claudeCheck.status === 'fail') {
    return { ok: false, message: `${claudeCheck.message}. ${claudeCheck.detail || ''}` };
  }

  // Check database directory (hard fail)
  const dbCheck = checkDatabaseDir(databasePath);
  if (dbCheck.status === 'fail') {
    return { ok: false, message: `${dbCheck.message}. ${dbCheck.detail || ''}` };
  }

  // Check port (hard fail)
  const portCheck = await checkPortAvailable(port);
  if (portCheck.status === 'fail') {
    return { ok: false, message: `${portCheck.message}. ${portCheck.detail || ''}` };
  }

  // Auth check is a warning, not a failure
  return { ok: true };
}

/**
 * Run comprehensive diagnostics and print results
 * Used with --doctor flag
 */
export async function runDoctor(options: PrerequisiteOptions = {}): Promise<void> {
  const { port = DEFAULT_PORT, databasePath = DEFAULT_DATABASE_PATH } = options;

  console.log('Cast Doctor');
  console.log('───────────');
  console.log('');

  const checks: DoctorCheckResult[] = [];

  // Run all checks
  checks.push(checkNodeVersion());
  checks.push(await checkSqliteModule());
  checks.push(checkClaudeCli());
  checks.push(checkClaudeAuth());
  checks.push(checkDatabaseDir(databasePath));
  checks.push(await checkPortAvailable(port));

  // Print results
  let hasFailure = false;
  for (const check of checks) {
    const icon = check.status === 'pass' ? '\u2713' : check.status === 'warn' ? '\u26A0' : '\u2717';
    const color = check.status === 'pass' ? '' : check.status === 'warn' ? '' : '';

    console.log(`${icon} ${check.message}`);

    if (check.detail && check.status !== 'pass') {
      // Indent detail lines
      const detailLines = check.detail.split('\n');
      for (const line of detailLines) {
        console.log(`  ${line}`);
      }
    }

    if (check.status === 'fail') {
      hasFailure = true;
    }
  }

  console.log('');
  if (hasFailure) {
    console.log('Some checks failed. Fix the issues above and try again.');
  } else {
    console.log('All checks passed! Run `npx @sanity/cast` to start.');
  }
}
