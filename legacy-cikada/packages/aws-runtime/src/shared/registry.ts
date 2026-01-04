/**
 * Process Registry
 *
 * Shared registry for agents and workflows.
 * Allows different Lambda handlers to access registered processes.
 */

import type { ProcessDefinition } from "@cikada/agent";

let _processes: Record<string, ProcessDefinition> = {};

/**
 * Register processes for this Lambda.
 */
export function registerProcesses(processes: Record<string, ProcessDefinition>): void {
  _processes = processes;
}

/**
 * Get all registered processes.
 */
export function getRegisteredProcesses(): Record<string, ProcessDefinition> {
  return _processes;
}

/**
 * Get a specific process by name.
 */
export function getProcess(name: string): ProcessDefinition | undefined {
  return _processes[name];
}
