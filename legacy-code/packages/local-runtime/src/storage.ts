/**
 * In-memory storage for local development.
 * Stores threads and their messages.
 */

// =============================================================================
// Types
// =============================================================================

export interface StoredMessage {
  id: string;
  threadId: string;
  value: Record<string, unknown>;
  timestamp: string;
  isComplete: boolean;
}

export interface ThreadState {
  threadId: string;
  agentName: string;
  status: "idle" | "running" | "error" | "completed";
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// In-Memory Storage
// =============================================================================

export class MemoryStorage {
  private threads: Map<string, ThreadState> = new Map();
  private messages: Map<string, StoredMessage[]> = new Map();

  // ---------------------------------------------------------------------------
  // Thread Operations
  // ---------------------------------------------------------------------------

  async getThread(threadId: string): Promise<ThreadState | null> {
    return this.threads.get(threadId) ?? null;
  }

  async saveThread(state: ThreadState): Promise<void> {
    this.threads.set(state.threadId, state);
  }

  async createThread(threadId: string, agentName: string): Promise<ThreadState> {
    const now = new Date().toISOString();
    const state: ThreadState = {
      threadId,
      agentName,
      status: "idle",
      createdAt: now,
      updatedAt: now,
    };
    this.threads.set(threadId, state);
    this.messages.set(threadId, []);
    return state;
  }

  async updateThreadStatus(
    threadId: string,
    status: ThreadState["status"]
  ): Promise<void> {
    const thread = this.threads.get(threadId);
    if (thread) {
      thread.status = status;
      thread.updatedAt = new Date().toISOString();
    }
  }

  // ---------------------------------------------------------------------------
  // Message Operations
  // ---------------------------------------------------------------------------

  async getMessages(threadId: string, since?: string): Promise<StoredMessage[]> {
    const messages = this.messages.get(threadId) ?? [];

    if (!since) {
      return messages;
    }

    // Filter by timestamp (>= since for safe reconnect)
    return messages.filter((m) => m.timestamp >= since);
  }

  async saveMessage(message: StoredMessage): Promise<void> {
    const messages = this.messages.get(message.threadId);
    if (!messages) {
      this.messages.set(message.threadId, [message]);
      return;
    }

    // Find existing message by ID and update, or append
    const existingIndex = messages.findIndex((m) => m.id === message.id);
    if (existingIndex >= 0) {
      messages[existingIndex] = message;
    } else {
      messages.push(message);
    }
  }

  async deleteMessage(threadId: string, messageId: string): Promise<void> {
    const messages = this.messages.get(threadId);
    if (messages) {
      const index = messages.findIndex((m) => m.id === messageId);
      if (index >= 0) {
        messages.splice(index, 1);
      }
    }
  }

  async getMessage(threadId: string, messageId: string): Promise<StoredMessage | null> {
    const messages = this.messages.get(threadId);
    if (!messages) return null;
    return messages.find((m) => m.id === messageId) ?? null;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  async listThreads(): Promise<ThreadState[]> {
    return Array.from(this.threads.values());
  }

  async clear(): Promise<void> {
    this.threads.clear();
    this.messages.clear();
  }
}

// Singleton for the local runtime
export const storage = new MemoryStorage();
