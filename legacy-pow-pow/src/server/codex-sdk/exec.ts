import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { SandboxMode, ModelReasoningEffort, ApprovalMode, McpServerConfig } from "./threadOptions.js";

export type CodexExecArgs = {
  input: string;

  baseUrl?: string;
  apiKey?: string;
  threadId?: string | null;
  images?: string[];
  // --model
  model?: string;
  // --sandbox
  sandboxMode?: SandboxMode;
  // --cd
  workingDirectory?: string;
  // --add-dir
  additionalDirectories?: string[];
  // --skip-git-repo-check
  skipGitRepoCheck?: boolean;
  // --output-schema
  outputSchemaFile?: string;
  // --config model_reasoning_effort
  modelReasoningEffort?: ModelReasoningEffort;
  // AbortSignal to cancel the execution
  signal?: AbortSignal;
  // --config sandbox_workspace_write.network_access
  networkAccessEnabled?: boolean;
  // --config features.web_search_request
  webSearchEnabled?: boolean;
  // --config approval_policy
  approvalPolicy?: ApprovalMode;
  // MCP servers (--config mcp_servers.*)
  mcpServers?: Record<string, McpServerConfig>;
};

const INTERNAL_ORIGINATOR_ENV = "CODEX_INTERNAL_ORIGINATOR_OVERRIDE";
const TYPESCRIPT_SDK_ORIGINATOR = "codex_sdk_ts";

export class CodexExec {
  private executablePath: string;
  private envOverride?: Record<string, string>;

  constructor(executablePath: string | null = null, env?: Record<string, string>) {
    this.executablePath = executablePath || findCodexPath();
    this.envOverride = env;
  }

  async *run(args: CodexExecArgs): AsyncGenerator<string> {
    const commandArgs: string[] = ["exec", "--experimental-json"];

    if (args.model) {
      commandArgs.push("--model", args.model);
    }

    if (args.sandboxMode) {
      commandArgs.push("--sandbox", args.sandboxMode);
    }

    if (args.workingDirectory) {
      commandArgs.push("--cd", args.workingDirectory);
    }

    if (args.additionalDirectories?.length) {
      for (const dir of args.additionalDirectories) {
        commandArgs.push("--add-dir", dir);
      }
    }

    if (args.skipGitRepoCheck) {
      commandArgs.push("--skip-git-repo-check");
    }

    if (args.outputSchemaFile) {
      commandArgs.push("--output-schema", args.outputSchemaFile);
    }

    if (args.modelReasoningEffort) {
      commandArgs.push("--config", `model_reasoning_effort="${args.modelReasoningEffort}"`);
    }

    if (args.networkAccessEnabled !== undefined) {
      commandArgs.push(
        "--config",
        `sandbox_workspace_write.network_access=${args.networkAccessEnabled}`,
      );
    }

    if (args.webSearchEnabled !== undefined) {
      commandArgs.push("--config", `features.web_search_request=${args.webSearchEnabled}`);
    }

    if (args.approvalPolicy) {
      commandArgs.push("--config", `approval_policy="${args.approvalPolicy}"`);
    }

    // MCP server configuration
    if (args.mcpServers) {
      for (const [serverName, config] of Object.entries(args.mcpServers)) {
        // URL is required
        commandArgs.push("--config", `mcp_servers.${serverName}.url="${config.url}"`);
        // Optional bearer token env var
        if (config.bearerTokenEnvVar) {
          commandArgs.push("--config", `mcp_servers.${serverName}.bearer_token_env_var="${config.bearerTokenEnvVar}"`);
        }
        // Optional HTTP headers (as inline table)
        if (config.httpHeaders && Object.keys(config.httpHeaders).length > 0) {
          const headerPairs = Object.entries(config.httpHeaders)
            .map(([k, v]) => `"${k}"="${v}"`)
            .join(", ");
          commandArgs.push("--config", `mcp_servers.${serverName}.http_headers={${headerPairs}}`);
        }
      }
    }

    if (args.images?.length) {
      for (const image of args.images) {
        commandArgs.push("--image", image);
      }
    }

    if (args.threadId) {
      commandArgs.push("resume", args.threadId);
    }

    const env: Record<string, string> = {};
    if (this.envOverride) {
      Object.assign(env, this.envOverride);
    } else {
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined) {
          env[key] = value;
        }
      }
    }
    if (!env[INTERNAL_ORIGINATOR_ENV]) {
      env[INTERNAL_ORIGINATOR_ENV] = TYPESCRIPT_SDK_ORIGINATOR;
    }
    if (args.baseUrl) {
      env.OPENAI_BASE_URL = args.baseUrl;
    }
    if (args.apiKey) {
      env.CODEX_API_KEY = args.apiKey;
    }

    const child = spawn(this.executablePath, commandArgs, {
      env,
      signal: args.signal,
    });

    let spawnError: unknown | null = null;
    child.once("error", (err) => (spawnError = err));

    if (!child.stdin) {
      child.kill();
      throw new Error("Child process has no stdin");
    }
    child.stdin.write(args.input);
    child.stdin.end();

    if (!child.stdout) {
      child.kill();
      throw new Error("Child process has no stdout");
    }
    const stderrChunks: Buffer[] = [];

    if (child.stderr) {
      child.stderr.on("data", (data) => {
        stderrChunks.push(data);
      });
    }

    const rl = readline.createInterface({
      input: child.stdout,
      crlfDelay: Infinity,
    });

    try {
      for await (const line of rl) {
        // `line` is a string (Node sets default encoding to utf8 for readline)
        yield line as string;
      }

      const exitCode = new Promise((resolve, reject) => {
        child.once("exit", (code) => {
          if (code === 0) {
            resolve(code);
          } else {
            const stderrBuffer = Buffer.concat(stderrChunks);
            reject(
              new Error(`Codex Exec exited with code ${code}: ${stderrBuffer.toString("utf8")}`),
            );
          }
        });
      });

      if (spawnError) throw spawnError;
      await exitCode;
    } finally {
      rl.close();
      child.removeAllListeners();
      try {
        if (!child.killed) child.kill();
      } catch {
        // ignore
      }
    }
  }
}

import { existsSync } from "node:fs";
import { execSync } from "node:child_process";

const scriptFileName = fileURLToPath(import.meta.url);
const scriptDirName = path.dirname(scriptFileName);

function findCodexPath(): string {
  const codexBinaryName = process.platform === "win32" ? "codex.exe" : "codex";

  // 1. Check if codex is in PATH (globally installed)
  try {
    const whichCmd = process.platform === "win32" ? "where" : "which";
    const globalPath = execSync(`${whichCmd} ${codexBinaryName}`, { encoding: "utf8" }).trim().split("\n")[0];
    if (globalPath && existsSync(globalPath)) {
      return globalPath;
    }
  } catch {
    // Not found in PATH, continue to check other locations
  }

  // 2. Check in node_modules/@openai/codex-sdk/vendor
  const targetTriple = getTargetTriple();
  if (targetTriple) {
    // Find node_modules - walk up from script location
    let dir = scriptDirName;
    while (dir !== path.dirname(dir)) {
      const nodeModulesPath = path.join(dir, "node_modules", "@openai", "codex-sdk", "vendor", targetTriple, "codex", codexBinaryName);
      if (existsSync(nodeModulesPath)) {
        return nodeModulesPath;
      }
      dir = path.dirname(dir);
    }
  }

  throw new Error(`Could not find codex binary. Install it globally with: npm install -g @openai/codex`);
}

function getTargetTriple(): string | null {
  const { platform, arch } = process;

  switch (platform) {
    case "linux":
    case "android":
      switch (arch) {
        case "x64":
          return "x86_64-unknown-linux-musl";
        case "arm64":
          return "aarch64-unknown-linux-musl";
        default:
          return null;
      }
    case "darwin":
      switch (arch) {
        case "x64":
          return "x86_64-apple-darwin";
        case "arm64":
          return "aarch64-apple-darwin";
        default:
          return null;
      }
    case "win32":
      switch (arch) {
        case "x64":
          return "x86_64-pc-windows-msvc";
        case "arm64":
          return "aarch64-pc-windows-msvc";
        default:
          return null;
      }
    default:
      return null;
  }
}
