import { Client, ActivityType } from 'discord.js';

export type BotActivityStatus = 'idle' | 'thinking' | 'working' | 'writing';

export class ActivityManager {
  private currentStatus: BotActivityStatus = 'idle';
  private lastUpdate: number = 0;
  private updateThrottleMs: number = 5000; // Discord rate limit: max 5 updates/min

  constructor(private client: Client) {}

  setStatus(status: BotActivityStatus, force: boolean = false): void {
    // Check if already at this status
    if (this.currentStatus === status && !force) {
      return;
    }

    // Throttle updates to avoid rate limits (unless forced)
    const now = Date.now();
    if (!force && now - this.lastUpdate < this.updateThrottleMs) {
      return;
    }

    this.currentStatus = status;
    this.lastUpdate = now;

    const statusMap = {
      idle: { type: ActivityType.Custom, name: '💤 Idle' },
      thinking: { type: ActivityType.Custom, name: '🤔 Thinking...' },
      working: { type: ActivityType.Custom, name: '⚙️ Working...' },
      writing: { type: ActivityType.Custom, name: '✍️ Writing...' }
    };

    this.client.user?.setActivity(statusMap[status]);
  }

  reset(): void {
    // Force the reset to bypass throttling - we always want to return to idle
    this.setStatus('idle', true);
  }
}
