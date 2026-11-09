import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID, createHash } from 'node:crypto';
import {
  mkdirSync,
  appendFileSync,
  statSync,
  renameSync,
  unlinkSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
type Field = string | number | boolean | null | undefined;
const context = new AsyncLocalStorage<Record<string, Field>>();
const sensitive =
  /cookie|token|authorization|password|secret|session|csrf|headers|payload|body|text|html|email|chatid|chat_id|url|path|message|stack/i;
export const reference = (value: string) =>
  createHash('sha256').update(value).digest('hex').slice(0, 16);
export function errorFields(error: unknown): Record<string, Field> {
  if (!error || typeof error !== 'object') return { errorType: 'unknown' };
  const e = error as {
    name?: unknown;
    code?: unknown;
    reason?: unknown;
    cause?: { code?: unknown };
  };
  const safe = (value: unknown) =>
    typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,80}$/.test(value)
      ? value
      : undefined;
  return {
    errorType: safe(e.name) ?? 'Error',
    errorCode: safe(e.code) ?? safe(e.cause?.code),
    reason: safe(e.reason),
  };
}
export function sanitize(fields: Record<string, Field>): Record<string, Field> {
  const result: Record<string, Field> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (sensitive.test(key)) {
      result[key] = '[REDACTED]';
      continue;
    }
    if (typeof value === 'string') {
      const cleaned = value
        .replace(/https?:\/\/\S+/gi, '[URL]')
        .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, '[EMAIL]');
      result[key] = cleaned.slice(0, 500);
    } else if (typeof value === 'number')
      result[key] = Number.isFinite(value) ? value : null;
    else if (typeof value === 'boolean' || value === null) result[key] = value;
  }
  return result;
}
export function withLogContext<T>(
  fields: Record<string, Field>,
  operation: () => T,
): T {
  return context.run({ ...context.getStore(), ...sanitize(fields) }, operation);
}
export class RotatingLogFile {
  private day = '';
  private bytes = 0;
  private active = '';
  constructor(
    private readonly directory: string,
    private readonly service: string,
    private readonly maxBytes = 5 * 1024 * 1024,
    private readonly backups = 3,
    private readonly days = 7,
  ) {
    if (!/^[a-z][a-z0-9-]{0,40}$/.test(service))
      throw Error('Invalid log service');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  write(line: string, now = new Date()) {
    const day = now.toISOString().slice(0, 10);
    if (day !== this.day) {
      this.day = day;
      this.active = join(this.directory, `${this.service}-${day}.jsonl`);
      try {
        this.bytes = statSync(this.active).size;
      } catch {
        this.bytes = 0;
      }
      const cutoff = now.getTime() - this.days * 86400000;
      for (const name of readdirSync(this.directory)) {
        const match = name.match(
          new RegExp(
            `^${this.service}-(\\d{4}-\\d{2}-\\d{2})\\.jsonl(?:\\.[1-5])?$`,
          ),
        );
        if (match && Date.parse(match[1]!) < cutoff)
          unlinkSync(join(this.directory, name));
      }
    }
    const bytes = Buffer.byteLength(line + '\n');
    if (this.bytes + bytes > this.maxBytes && this.bytes > 0) {
      try {
        unlinkSync(this.active + '.' + this.backups);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      for (let i = this.backups - 1; i >= 0; i--) {
        try {
          renameSync(
            i ? this.active + '.' + i : this.active,
            this.active + '.' + (i + 1),
          );
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
      }
      this.bytes = 0;
    }
    appendFileSync(this.active, line + '\n', { mode: 0o600 });
    this.bytes += bytes;
  }
}
const installed = new Set<string>();
const writers = new Map<string, RotatingLogFile>();
let lastFailure = 0;
const configuredInt = (
  name: string,
  fallback: number,
  min: number,
  max: number,
) => {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
};
export function log(
  service: string,
  event: string,
  fields: Record<string, Field> = {},
  level: 'info' | 'warn' | 'error' = 'info',
) {
  const line = JSON.stringify({
    ...sanitize({ ...context.getStore(), ...fields }),
    timestamp: new Date().toISOString(),
    service,
    event,
    level,
    pid: process.pid,
  });
  process.stdout.write(line + '\n');
  if (!process.env.LOG_DIR) return;
  try {
    let writer = writers.get(service);
    if (!writer) {
      writer = new RotatingLogFile(
        process.env.LOG_DIR,
        service,
        configuredInt(
          'LOG_MAX_BYTES',
          5 * 1024 * 1024,
          1024,
          100 * 1024 * 1024,
        ),
        configuredInt('LOG_BACKUPS', 3, 1, 5),
        configuredInt('LOG_RETENTION_DAYS', 7, 1, 30),
      );
      writers.set(service, writer);
    }
    writer.write(line);
  } catch (error) {
    if (Date.now() - lastFailure > 60000) {
      lastFailure = Date.now();
      process.stderr.write(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          service,
          event: 'log_file_failed',
          level: 'error',
          ...errorFields(error),
        }) + '\n',
      );
    }
  }
}
export function installProcessLogging(service: string) {
  if (installed.has(service)) return;
  installed.add(service);
  process.on('uncaughtExceptionMonitor', (error) =>
    log(service, 'uncaught_exception', errorFields(error), 'error'),
  );
  process.on('warning', (warning) =>
    log(service, 'process_warning', errorFields(warning), 'warn'),
  );
}
export const newTraceId = () => randomUUID();

if (process.env.LOG_SERVICE) installProcessLogging(process.env.LOG_SERVICE);

export function failureLevel(code: unknown): 'info' | 'warn' {
  return ['budget', 'request_limit', 'protection_pause', 'cooldown'].includes(
    String(code),
  )
    ? 'info'
    : 'warn';
}
