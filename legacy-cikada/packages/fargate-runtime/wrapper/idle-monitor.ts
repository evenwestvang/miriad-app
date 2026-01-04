/**
 * Idle Monitor
 *
 * Tracks activity and shuts down the container after a period of inactivity.
 * Default timeout: 10 minutes.
 */

export interface IdleMonitorConfig {
  timeoutMs?: number;
  checkIntervalMs?: number;
  onShutdown?: () => Promise<void>;
}

export class IdleMonitor {
  private lastActivity: Date = new Date();
  private readonly timeoutMs: number;
  private readonly checkIntervalMs: number;
  private readonly onShutdown: () => Promise<void>;
  private intervalId: NodeJS.Timeout | null = null;

  constructor(config: IdleMonitorConfig = {}) {
    this.timeoutMs = config.timeoutMs ?? 10 * 60 * 1000; // 10 minutes default
    this.checkIntervalMs = config.checkIntervalMs ?? 30_000; // 30 seconds
    this.onShutdown = config.onShutdown ?? (async () => process.exit(0));
  }

  /**
   * Reset the idle timer - call this on any activity.
   */
  touch(): void {
    this.lastActivity = new Date();
  }

  /**
   * Get milliseconds since last activity.
   */
  getIdleMs(): number {
    return Date.now() - this.lastActivity.getTime();
  }

  /**
   * Start the idle monitor.
   */
  start(): void {
    if (this.intervalId) {
      return; // Already running
    }

    console.log(`[IdleMonitor] Started with ${this.timeoutMs / 1000}s timeout`);

    this.intervalId = setInterval(async () => {
      const idleMs = this.getIdleMs();
      const idleSec = Math.round(idleMs / 1000);

      if (idleMs > this.timeoutMs) {
        console.log(`[IdleMonitor] Idle timeout reached (${idleSec}s), initiating shutdown`);
        this.stop();
        await this.onShutdown();
      } else if (idleMs > this.timeoutMs * 0.8) {
        // Warn when 80% of timeout reached
        const remainingSec = Math.round((this.timeoutMs - idleMs) / 1000);
        console.log(`[IdleMonitor] Warning: ${remainingSec}s until idle timeout`);
      }
    }, this.checkIntervalMs);
  }

  /**
   * Stop the idle monitor.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
      console.log("[IdleMonitor] Stopped");
    }
  }
}
