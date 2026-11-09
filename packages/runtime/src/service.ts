import express from 'express';
import type pg from 'pg';
import { runTask, type ScheduledTask } from './scheduler.js';
import { log } from './logger.js';

export async function runService(options: {
  name: string;
  port: number;
  intervalMs: number;
  pool: pg.Pool;
  tick?: (signal: AbortSignal) => Promise<void>;
  tasks?: ScheduledTask[];
  diagnostics?: () => Promise<unknown>;
  readyCheck?: () => boolean | Promise<boolean>;
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
      if (options.readyCheck && !(await options.readyCheck()))
        throw new Error('Dependency unavailable');
      await pool.query('SELECT 1 FROM queue.jobs LIMIT 0');
      res.json({ service: name, status: 'ready' });
    } catch {
      res.status(503).json({ service: name, status: 'unavailable' });
    }
  });
  if (options.diagnostics)
    app.get('/status', async (_req, res) => {
      try {
        res.json(await options.diagnostics!());
      } catch {
        res.status(503).json({ status: 'unavailable' });
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
    const tasks = options.tasks ?? (tick ? [{ name, intervalMs, tick }] : []);
    await Promise.all(
      tasks.map((task) =>
        runTask(task, abort.signal, (taskName) =>
          log(name, 'tick_failed', { task: taskName }),
        ),
      ),
    );
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    log(name, 'stopped');
  }
}
