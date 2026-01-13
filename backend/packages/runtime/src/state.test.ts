import { describe, it, expect, beforeEach } from 'vitest';
import {
  AgentStateManager,
  deriveStateFromCheckin,
  deriveStateFromFrame,
  deriveStateFromSuspend,
  deriveStateFromError,
  deriveStateFromActivate,
  createInitialState,
} from './state.js';

// =============================================================================
// Pure Function Tests
// =============================================================================

describe('deriveStateFromActivate', () => {
  it('transitions offline to activating', () => {
    expect(deriveStateFromActivate('offline')).toBe('activating');
  });

  it('keeps activating as activating (idempotent)', () => {
    expect(deriveStateFromActivate('activating')).toBe('activating');
  });

  it('keeps online as online (idempotent)', () => {
    expect(deriveStateFromActivate('online')).toBe('online');
  });

  it('keeps busy as busy (idempotent)', () => {
    expect(deriveStateFromActivate('busy')).toBe('busy');
  });

  it('transitions error to activating', () => {
    expect(deriveStateFromActivate('error')).toBe('activating');
  });
});

describe('deriveStateFromCheckin', () => {
  it('transitions activating to online', () => {
    expect(deriveStateFromCheckin('activating')).toBe('online');
  });

  it('keeps online as online (idempotent)', () => {
    expect(deriveStateFromCheckin('online')).toBe('online');
  });

  it('keeps busy as busy', () => {
    expect(deriveStateFromCheckin('busy')).toBe('busy');
  });

  it('transitions offline to online (unexpected but handled)', () => {
    expect(deriveStateFromCheckin('offline')).toBe('online');
  });
});

describe('deriveStateFromFrame', () => {
  it('transitions online to busy when not idle', () => {
    expect(deriveStateFromFrame('online', false)).toBe('busy');
  });

  it('transitions busy to online when idle', () => {
    expect(deriveStateFromFrame('busy', true)).toBe('online');
  });

  it('keeps online when idle', () => {
    expect(deriveStateFromFrame('online', true)).toBe('online');
  });

  it('keeps busy when not idle', () => {
    expect(deriveStateFromFrame('busy', false)).toBe('busy');
  });

  it('ignores frames when offline', () => {
    expect(deriveStateFromFrame('offline', false)).toBe('offline');
  });

  it('ignores frames when activating', () => {
    expect(deriveStateFromFrame('activating', false)).toBe('activating');
  });
});

describe('deriveStateFromSuspend', () => {
  it('always returns offline', () => {
    expect(deriveStateFromSuspend('online')).toBe('offline');
    expect(deriveStateFromSuspend('busy')).toBe('offline');
    expect(deriveStateFromSuspend('activating')).toBe('offline');
    expect(deriveStateFromSuspend('error')).toBe('offline');
  });
});

describe('deriveStateFromError', () => {
  it('always returns error', () => {
    expect(deriveStateFromError('online')).toBe('error');
    expect(deriveStateFromError('busy')).toBe('error');
    expect(deriveStateFromError('activating')).toBe('error');
    expect(deriveStateFromError('offline')).toBe('error');
  });
});

// =============================================================================
// AgentStateManager Class Tests
// =============================================================================

describe('AgentStateManager', () => {
  let manager: AgentStateManager;
  const agentId = 'space1:channel1:agent1';

  beforeEach(() => {
    manager = new AgentStateManager();
  });

  describe('handleActivate', () => {
    it('creates new state in activating status', () => {
      const state = manager.handleActivate(agentId);
      expect(state.agentId).toBe(agentId);
      expect(state.status).toBe('activating');
      expect(state.activatedAt).toBeTruthy();
    });

    it('stores container info', () => {
      const state = manager.handleActivate(agentId, {
        container: { containerId: 'abc123', runtime: 'docker' },
        port: 8080,
      });
      expect(state.container?.containerId).toBe('abc123');
      expect(state.port).toBe(8080);
    });

    it('is idempotent when already activating', () => {
      manager.handleActivate(agentId);
      const state = manager.handleActivate(agentId);
      expect(state.status).toBe('activating');
    });
  });

  describe('handleCheckin', () => {
    it('transitions from activating to online', () => {
      manager.handleActivate(agentId);
      const state = manager.handleCheckin(agentId, 'http://localhost:8080');
      expect(state.status).toBe('online');
      expect(state.endpoint).toBe('http://localhost:8080');
    });

    it('handles checkin for unknown agent', () => {
      const state = manager.handleCheckin(agentId);
      expect(state.status).toBe('online');
    });
  });

  describe('handleFrame', () => {
    it('transitions to busy on non-idle frame', () => {
      manager.handleActivate(agentId);
      manager.handleCheckin(agentId);
      const state = manager.handleFrame(agentId, false);
      expect(state.status).toBe('busy');
    });

    it('transitions to online on idle frame', () => {
      manager.handleActivate(agentId);
      manager.handleCheckin(agentId);
      manager.handleFrame(agentId, false);
      const state = manager.handleFrame(agentId, true);
      expect(state.status).toBe('online');
    });

    it('returns offline state for unknown agent', () => {
      const state = manager.handleFrame('unknown:agent:id', false);
      expect(state.status).toBe('offline');
    });
  });

  describe('handleSuspend', () => {
    it('transitions to offline and clears runtime info', () => {
      manager.handleActivate(agentId, {
        container: { containerId: 'abc', runtime: 'docker' },
        endpoint: 'http://localhost:8080',
      });
      manager.handleCheckin(agentId);

      const state = manager.handleSuspend(agentId);
      expect(state.status).toBe('offline');
      expect(state.endpoint).toBeNull();
      expect(state.container).toBeNull();
    });
  });

  describe('handleError', () => {
    it('transitions to error state', () => {
      manager.handleActivate(agentId);
      const state = manager.handleError(agentId, 'test error');
      expect(state.status).toBe('error');
    });
  });

  describe('handleTimeout', () => {
    it('transitions to error state', () => {
      manager.handleActivate(agentId);
      const state = manager.handleTimeout(agentId);
      expect(state.status).toBe('error');
    });
  });

  describe('query methods', () => {
    it('getState returns null for unknown agent', () => {
      expect(manager.getState('unknown')).toBeNull();
    });

    it('isOnline returns true for online agents', () => {
      manager.handleActivate(agentId);
      manager.handleCheckin(agentId);
      expect(manager.isOnline(agentId)).toBe(true);
    });

    it('isOnline returns true for busy agents', () => {
      manager.handleActivate(agentId);
      manager.handleCheckin(agentId);
      manager.handleFrame(agentId, false);
      expect(manager.isOnline(agentId)).toBe(true);
    });

    it('isOnline returns false for offline agents', () => {
      expect(manager.isOnline(agentId)).toBe(false);
    });

    it('getAllOnline returns only online/busy agents', () => {
      manager.handleActivate('a:b:agent1');
      manager.handleCheckin('a:b:agent1');

      manager.handleActivate('a:b:agent2');
      manager.handleCheckin('a:b:agent2');
      manager.handleFrame('a:b:agent2', false);

      manager.handleActivate('a:b:agent3'); // still activating

      const online = manager.getAllOnline();
      expect(online).toHaveLength(2);
      expect(online.map((s) => s.agentId).sort()).toEqual(['a:b:agent1', 'a:b:agent2']);
    });
  });

  describe('removeAgent', () => {
    it('removes agent from tracking', () => {
      manager.handleActivate(agentId);
      manager.removeAgent(agentId);
      expect(manager.getState(agentId)).toBeNull();
    });
  });

  describe('clear', () => {
    it('removes all agents', () => {
      manager.handleActivate('a:b:c1');
      manager.handleActivate('a:b:c2');
      manager.clear();
      expect(manager.getAllOnline()).toHaveLength(0);
    });
  });
});
