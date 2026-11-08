import { setTimeout as sleep } from 'node:timers/promises';
export interface ScheduledTask {
  name: string;
  intervalMs: number;
  tick(signal: AbortSignal): Promise<void>;
}
export const nextDelay = (
  intervalMs: number,
  startedAt: number,
  finishedAt: number,
) => Math.max(1000, intervalMs - Math.max(0, finishedAt - startedAt));
/** Independent cadence, no overlap and no accumulated catch-up burst. */
export async function runTask(
  task: ScheduledTask,
  signal: AbortSignal,
  onError: (name: string) => void,
) {
  while (!signal.aborted) {
    const started = Date.now();
    try {
      await task.tick(signal);
    } catch {
      if (!signal.aborted) onError(task.name);
    }
    await sleep(nextDelay(task.intervalMs, started, Date.now()), undefined, {
      signal,
    }).catch(() => undefined);
  }
}
