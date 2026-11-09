import express from 'express';
import type pg from 'pg';
import { runTask, type ScheduledTask } from './scheduler.js';
import {
  log,
  errorFields,
  installProcessLogging,
  withLogContext,
  newTraceId,
} from './logger.js';

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
  installProcessLogging(name);
  const abort = new AbortController();
  let previousReady: boolean | undefined;
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
      if (previousReady !== true)
        log(name, 'readiness_changed', { ready: true });
      previousReady = true;
      res.json({ service: name, status: 'ready' });
    } catch (error) {
      if (previousReady !== false)
        log(
          name,
          'readiness_changed',
          { ready: false, ...errorFields(error) },
          'warn',
        );
      previousReady = false;
      res.status(503).json({ service: name, status: 'unavailable' });
    }
  });
  if (options.diagnostics)
    app.get('/status', async (_req, res) => {
      try {
        res.json(await options.diagnostics!());
      } catch (error) {
        log(name, 'status_failed', errorFields(error), 'error');
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
  log(name, 'logging_configured', {
    fileLogging: !!process.env.LOG_DIR,
    retentionDays: Number(process.env.LOG_RETENTION_DAYS ?? 7),
    maxBytes: Number(process.env.LOG_MAX_BYTES ?? 5242880),
  });
  const heartbeat = setInterval(
    () =>
      log(name, 'heartbeat', {
        uptimeSeconds: Math.round(process.uptime()),
        memoryMb: Math.round(process.memoryUsage().rss / 1048576),
      }),
    60000,
  );
  heartbeat.unref();
  try {
    const tasks = options.tasks ?? (tick ? [{ name, intervalMs, tick }] : []);
    await Promise.all(
      tasks.map((task) =>
        runTask(
          {
            ...task,
            tick: (signal) =>
              withLogContext(
                { traceId: newTraceId(), task: task.name },
                async () => {
                  const started = Date.now();
                  try {
                    await task.tick(signal);
                  } catch (error) {
                    log(
                      name,
                      'tick_failed',
                      {
                        ...errorFields(error),
                        durationMs: Date.now() - started,
                      },
                      'error',
                    );
                    throw error;
                  }
                  if (task.intervalMs >= 60000)
                    log(name, 'tick_finished', {
                      durationMs: Date.now() - started,
                    });
                },
              ),
          },
          abort.signal,
          () => undefined,
        ),
      ),
    );
  } finally {
    clearInterval(heartbeat);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await pool.end();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    log(name, 'stopped');
  }
}
