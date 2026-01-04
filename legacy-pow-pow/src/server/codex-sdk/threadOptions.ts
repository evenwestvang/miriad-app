export type ApprovalMode = "never" | "on-request" | "on-failure" | "untrusted";

export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";

export type ModelReasoningEffort = "minimal" | "low" | "medium" | "high" | "xhigh";

/** MCP server configuration for HTTP/SSE servers */
export type McpServerConfig = {
  /** URL to access the server */
  url: string;
  /** Name of env var containing a bearer token */
  bearerTokenEnvVar?: string;
  /** Static HTTP headers */
  httpHeaders?: Record<string, string>;
};

export type ThreadOptions = {
  model?: string;
  sandboxMode?: SandboxMode;
  workingDirectory?: string;
  skipGitRepoCheck?: boolean;
  modelReasoningEffort?: ModelReasoningEffort;
  networkAccessEnabled?: boolean;
  webSearchEnabled?: boolean;
  approvalPolicy?: ApprovalMode;
  additionalDirectories?: string[];
  /** MCP servers to configure (key = server name) */
  mcpServers?: Record<string, McpServerConfig>;
};
