import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  createRuntimeRegistry,
  type LocalRuntime,
  type RuntimeRegistry,
} from './runtime-registry.js';
import type { AgentRuntime, AgentRuntimeState } from '@cast/runtime';
import type { Storage } from '@cast/storage';

// =============================================================================
// Mocks
// =============================================================================

function createMockRuntime(name: string): AgentRuntime & { _name: string } {
  return {
    activate: vi.fn().mockResolvedValue({} as AgentRuntimeState),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    suspend: vi.fn().mockResolvedValue(undefined),
    getState: vi.fn().mockReturnValue(null),
    isOnline: vi.fn().mockReturnValue(false),
    getAllOnline: vi.fn().mockReturnValue([]),
    shutdown: vi.fn().mockResolvedValue(undefined),
    _name: name, // For test identification
  };
}

function createMockLocalRuntime(runtimeId: string): LocalRuntime {
  return {
    ...createMockRuntime(`local-${runtimeId}`),
    runtimeId,
  } as LocalRuntime;
}

function createMockStorage(runtimeId: string | null = null): Storage {
  return {
    getRosterByCallsign: vi
      .fn()
      .mockResolvedValue(
        runtimeId ? { runtimeId, callsign: 'agent1' } : { callsign: 'agent1' }
      ),
  } as unknown as Storage;
}

// =============================================================================
// Tests
// =============================================================================

describe('RuntimeRegistry', () => {
  let registry: RuntimeRegistry;
  let defaultRuntime: AgentRuntime;
  let storage: Storage;

  beforeEach(() => {
    defaultRuntime = createMockRuntime('default');
    storage = createMockStorage(null);
    registry = createRuntimeRegistry({ storage, defaultRuntime });
  });

  describe('getRuntimeForAgent', () => {
    it('returns default runtime when roster has no runtime_id', async () => {
      const runtime = await registry.getRuntimeForAgent('space:channel:agent1');
      expect(runtime).toBe(defaultRuntime);
    });

    it('returns default runtime when roster entry not found', async () => {
      (storage.getRosterByCallsign as ReturnType<typeof vi.fn>).mockResolvedValue(null);
      const runtime = await registry.getRuntimeForAgent('space:channel:unknown');
      expect(runtime).toBe(defaultRuntime);
    });

    it('returns null when LocalRuntime is not connected', async () => {
      storage = createMockStorage('rt_123');
      registry = createRuntimeRegistry({ storage, defaultRuntime });

      const runtime = await registry.getRuntimeForAgent('space:channel:agent1');
      expect(runtime).toBeNull();
    });

    it('returns LocalRuntime when connected', async () => {
      storage = createMockStorage('rt_123');
      registry = createRuntimeRegistry({ storage, defaultRuntime });

      const localRuntime = createMockLocalRuntime('rt_123');
      registry.registerLocalRuntime('rt_123', localRuntime);

      const runtime = await registry.getRuntimeForAgent('space:channel:agent1');
      expect(runtime).toBe(localRuntime);
    });

    it('parses agentId correctly', async () => {
      await registry.getRuntimeForAgent('space1:channel2:callsign3');
      expect(storage.getRosterByCallsign).toHaveBeenCalledWith('channel2', 'callsign3');
    });
  });

  describe('registerLocalRuntime', () => {
    it('adds runtime to registry', () => {
      const localRuntime = createMockLocalRuntime('rt_456');
      registry.registerLocalRuntime('rt_456', localRuntime);

      expect(registry.getLocalRuntime('rt_456')).toBe(localRuntime);
      expect(registry.isLocalRuntimeConnected('rt_456')).toBe(true);
    });

    it('overwrites existing runtime with same ID', () => {
      const runtime1 = createMockLocalRuntime('rt_789');
      const runtime2 = createMockLocalRuntime('rt_789');

      registry.registerLocalRuntime('rt_789', runtime1);
      registry.registerLocalRuntime('rt_789', runtime2);

      expect(registry.getLocalRuntime('rt_789')).toBe(runtime2);
    });
  });

  describe('unregisterLocalRuntime', () => {
    it('removes runtime from registry', () => {
      const localRuntime = createMockLocalRuntime('rt_abc');
      registry.registerLocalRuntime('rt_abc', localRuntime);
      registry.unregisterLocalRuntime('rt_abc');

      expect(registry.getLocalRuntime('rt_abc')).toBeUndefined();
      expect(registry.isLocalRuntimeConnected('rt_abc')).toBe(false);
    });

    it('handles unregister of non-existent runtime gracefully', () => {
      expect(() => registry.unregisterLocalRuntime('rt_nonexistent')).not.toThrow();
    });
  });

  describe('getAllLocalRuntimes', () => {
    it('returns copy of all registered runtimes', () => {
      const rt1 = createMockLocalRuntime('rt_1');
      const rt2 = createMockLocalRuntime('rt_2');

      registry.registerLocalRuntime('rt_1', rt1);
      registry.registerLocalRuntime('rt_2', rt2);

      const all = registry.getAllLocalRuntimes();
      expect(all.size).toBe(2);
      expect(all.get('rt_1')).toBe(rt1);
      expect(all.get('rt_2')).toBe(rt2);
    });

    it('returns a copy, not the internal map', () => {
      const rt1 = createMockLocalRuntime('rt_1');
      registry.registerLocalRuntime('rt_1', rt1);

      const all = registry.getAllLocalRuntimes();
      all.delete('rt_1');

      // Internal map should be unchanged
      expect(registry.isLocalRuntimeConnected('rt_1')).toBe(true);
    });
  });

  describe('isLocalRuntimeConnected', () => {
    it('returns false for unknown runtime', () => {
      expect(registry.isLocalRuntimeConnected('rt_unknown')).toBe(false);
    });

    it('returns true for registered runtime', () => {
      registry.registerLocalRuntime('rt_known', createMockLocalRuntime('rt_known'));
      expect(registry.isLocalRuntimeConnected('rt_known')).toBe(true);
    });
  });

  describe('integration scenario', () => {
    it('handles runtime connect/disconnect cycle', async () => {
      storage = createMockStorage('rt_cycle');
      registry = createRuntimeRegistry({ storage, defaultRuntime });

      // Initially offline
      expect(await registry.getRuntimeForAgent('s:c:a')).toBeNull();

      // Runtime connects
      const localRuntime = createMockLocalRuntime('rt_cycle');
      registry.registerLocalRuntime('rt_cycle', localRuntime);
      expect(await registry.getRuntimeForAgent('s:c:a')).toBe(localRuntime);

      // Runtime disconnects
      registry.unregisterLocalRuntime('rt_cycle');
      expect(await registry.getRuntimeForAgent('s:c:a')).toBeNull();
    });
  });
});
