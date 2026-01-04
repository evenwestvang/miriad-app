/**
 * In-memory stores for test harness
 *
 * Simulates Cikada's message and artifact storage without external dependencies.
 */

import { ulid } from "ulid";

// =============================================================================
// Types
// =============================================================================

export interface Message {
  id: string;
  channel: string;
  sender: string;
  content: string;
  timestamp: string;
  type: "message" | "status" | "system";
}

export interface Artifact {
  id: string;
  slug: string;
  channel: string;
  type: "doc" | "code" | "task" | "decision";
  title?: string;
  tldr: string;
  content: string;
  status: "draft" | "published" | "archived";
  assignees: string[];
  labels: string[];
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface AgentState {
  agentId: string;
  channel: string;
  status: "idle" | "running" | "error";
  lastMessageId?: string;
  checkpoints: Map<string, unknown>;
  error?: string;
}

// =============================================================================
// Message Store
// =============================================================================

export class MessageStore {
  private messages: Message[] = [];

  add(message: Omit<Message, "id" | "timestamp">): Message {
    const msg: Message = {
      ...message,
      id: ulid(),
      timestamp: new Date().toISOString(),
    };
    this.messages.push(msg);
    return msg;
  }

  getAll(channel?: string): Message[] {
    if (channel) {
      return this.messages.filter((m) => m.channel === channel);
    }
    return [...this.messages];
  }

  getById(id: string): Message | undefined {
    return this.messages.find((m) => m.id === id);
  }

  getRecent(channel: string, limit = 50): Message[] {
    return this.messages
      .filter((m) => m.channel === channel)
      .slice(-limit);
  }

  clear(): void {
    this.messages = [];
  }

  count(): number {
    return this.messages.length;
  }
}

// =============================================================================
// Artifact Store
// =============================================================================

export class ArtifactStore {
  private artifacts: Map<string, Artifact> = new Map();

  private key(channel: string, slug: string): string {
    return `${channel}:${slug}`;
  }

  create(artifact: Omit<Artifact, "id" | "createdAt" | "updatedAt">): Artifact {
    const key = this.key(artifact.channel, artifact.slug);
    if (this.artifacts.has(key)) {
      throw new Error(`Artifact already exists: ${artifact.slug}`);
    }

    const now = new Date().toISOString();
    const newArtifact: Artifact = {
      ...artifact,
      id: ulid(),
      createdAt: now,
      updatedAt: now,
    };
    this.artifacts.set(key, newArtifact);
    return newArtifact;
  }

  get(channel: string, slug: string): Artifact | undefined {
    return this.artifacts.get(this.key(channel, slug));
  }

  update(
    channel: string,
    slug: string,
    updates: Partial<Omit<Artifact, "id" | "slug" | "channel" | "createdAt">>
  ): Artifact {
    const key = this.key(channel, slug);
    const existing = this.artifacts.get(key);
    if (!existing) {
      throw new Error(`Artifact not found: ${slug}`);
    }

    const updated: Artifact = {
      ...existing,
      ...updates,
      updatedAt: new Date().toISOString(),
    };
    this.artifacts.set(key, updated);
    return updated;
  }

  delete(channel: string, slug: string): boolean {
    return this.artifacts.delete(this.key(channel, slug));
  }

  list(channel?: string): Artifact[] {
    const all = Array.from(this.artifacts.values());
    if (channel) {
      return all.filter((a) => a.channel === channel);
    }
    return all;
  }

  query(options: {
    channel?: string;
    type?: Artifact["type"];
    status?: Artifact["status"];
    assignee?: string;
  }): Artifact[] {
    return this.list(options.channel).filter((a) => {
      if (options.type && a.type !== options.type) return false;
      if (options.status && a.status !== options.status) return false;
      if (options.assignee && !a.assignees.includes(options.assignee))
        return false;
      return true;
    });
  }

  clear(): void {
    this.artifacts.clear();
  }

  count(): number {
    return this.artifacts.size;
  }
}

// =============================================================================
// Agent State Store
// =============================================================================

export class AgentStateStore {
  private states: Map<string, AgentState> = new Map();

  private key(channel: string, agentId: string): string {
    return `${channel}:${agentId}`;
  }

  get(channel: string, agentId: string): AgentState | undefined {
    return this.states.get(this.key(channel, agentId));
  }

  set(state: AgentState): void {
    this.states.set(this.key(state.channel, state.agentId), state);
  }

  setStatus(
    channel: string,
    agentId: string,
    status: AgentState["status"],
    error?: string
  ): void {
    const key = this.key(channel, agentId);
    const existing = this.states.get(key);
    if (existing) {
      existing.status = status;
      existing.error = error;
    }
  }

  saveCheckpoint(
    channel: string,
    agentId: string,
    stepId: string,
    value: unknown
  ): void {
    const key = this.key(channel, agentId);
    const state = this.states.get(key);
    if (state) {
      state.checkpoints.set(stepId, value);
    }
  }

  getCheckpoint(
    channel: string,
    agentId: string,
    stepId: string
  ): unknown | undefined {
    const state = this.states.get(this.key(channel, agentId));
    return state?.checkpoints.get(stepId);
  }

  clear(): void {
    this.states.clear();
  }
}
