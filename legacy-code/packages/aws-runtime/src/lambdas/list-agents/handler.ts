/**
 * List Agents Handler
 *
 * HTTP GET /agents
 *
 * Returns the list of available agents registered with the runtime.
 */

import type { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { getRegisteredProcesses } from "../../shared/registry.js";

export interface AgentInfo {
  id: string;
  name: string;
  kind: "agent" | "workflow";
}

export const handler: APIGatewayProxyHandlerV2 = async () => {
  const processes = getRegisteredProcesses();

  const agents: AgentInfo[] = Object.entries(processes).map(([id, process]) => ({
    id,
    name: process.name ?? id,
    kind: process.kind,
  }));

  // Add built-in agents that aren't in the registry
  // Claude Code runs in Fargate containers, managed by orchestrator
  if (process.env.ORCHESTRATOR_FUNCTION_NAME) {
    agents.push({
      id: "claude-code",
      name: "Claude Code",
      kind: "agent",
    });
  }

  return {
    statusCode: 200,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ agents }),
  };
};
