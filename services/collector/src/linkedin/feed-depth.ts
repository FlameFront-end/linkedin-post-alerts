import type { StateStore } from '../state.js';
/** Refresh the top often; keep deeper pagination on a separate, slower cadence. */
export class FeedDepthSchedule {
  private nextAt: number | undefined;
  constructor(
    private readonly intervalMs: number,
    private readonly state?: StateStore,
    private readonly now = Date.now,
  ) {}
  async due(): Promise<boolean> {
    if (this.nextAt === undefined) {
      const saved = await this.state?.load('feed_depth');
      const value =
        saved && typeof saved === 'object'
          ? (saved as { nextAt?: unknown }).nextAt
          : undefined;
      this.nextAt =
        typeof value === 'number' && Number.isFinite(value) && value >= 0
          ? value
          : this.now() + this.intervalMs;
      await this.state?.save('feed_depth', { nextAt: this.nextAt });
    }
    if (this.now() < this.nextAt) return false;
    this.nextAt = this.now() + this.intervalMs;
    await this.state?.save('feed_depth', { nextAt: this.nextAt });
    return true;
  }
}
