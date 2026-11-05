import express from 'express';
import type pg from 'pg';
import { setTimeout as sleep } from 'node:timers/promises';
import { log } from './logger.js';

export async function runService(options: {
  name: string;
  port: number;
  intervalMs: number;
  pool: pg.Pool;
  tick: (signal: AbortSignal) => Promise<void>;
  readyCheck?: () => boolean;
}) {
  const { name, port, intervalMs, pool, tick } = options;
  const abort = new AbortController();
  const app = express();
  app.disable('x-powered-by');
  app.get('/health/live', (_req, res) => {
    res.json({ service: name, status: 'alive' });
  });
  app.get('/health/ready', async (_req, res) => {
    try {
      if (options.readyCheck && !options.readyCheck())
        throw new Error('Dependency unavailable');
      await pool.query('SELECT 1 FROM queue.jobs LIMIT 0');
      res.json({ service: name, status: 'ready' });
    } catch {
      res.status(503).json({ service: name, status: 'unavailable' });
    }
  });
  const server = app.listen(port);
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const stop = () => {
    abort.abort();
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  log(name, 'started', { port });
  try {
    while (!abort.signal.aborted) {
      try {
        await tick(abort.signal);
      } catch {
        log(name, 'tick_failed');
      }
      await sleep(intervalMs, undefined, { signal: abort.signal }).catch(
        () => undefined,
      );
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    log(name, 'stopped');
  }
}
