import { alertSchema } from '../../../packages/contracts/src/index.js';
import type { Database } from '../../../packages/runtime/src/db.js';
import { LinkedInError } from './linkedin/errors.js';
import type { LinkedInSource } from './sources/linkedin.js';

export interface AlertDraft {
  code: string;
  message: string;
}

/** Decide whether the owner must be told that collection is not working. */
export function alertFor(
  source: LinkedInSource,
  error?: unknown,
): AlertDraft | undefined {
  const code =
    error instanceof LinkedInError
      ? error.code
      : (source.haltedCode ?? undefined);
  if (code === 'auth_required')
    return {
      code,
      message:
        'Сбор LinkedIn остановлен: сессия недействительна или требуется вход. ' +
        'Обновите .local/session.json и перезапустите collector.',
    };
  if (code === 'rate_limited')
    return {
      code,
      message: `LinkedIn ограничил запросы (429). Сбор приостановлен до ${new Date(
        source.pausedUntilMs,
      ).toISOString()}. Стоит уменьшить число запросов в .local/linkedin.json.`,
    };
  if (!error && source.failing())
    return {
      code: 'collection_failing',
      message:
        'Ни один источник LinkedIn не отработал успешно: ' +
        source.reports.map((report) => report.status).join(', ') +
        '. Проверьте шаблоны запросов и npm run linkedin:check.',
    };
  return undefined;
}

/** One alert per code per UTC day: repeated failing ticks do not spam the chat. */
export async function raiseAlert(
  db: Database,
  draft: AlertDraft,
  now = new Date(),
) {
  const alert = alertSchema.parse({
    source: 'collector',
    code: draft.code,
    message: draft.message,
    at: now.toISOString(),
  });
  await db.query(
    `INSERT INTO queue.jobs(kind,dedupe_key,payload) VALUES('alert',$1,$2)
    ON CONFLICT(kind,dedupe_key) DO UPDATE SET payload=excluded.payload
    WHERE queue.jobs.status='pending'`,
    [
      `collector:${draft.code}:${now.toISOString().slice(0, 10)}`,
      JSON.stringify(alert),
    ],
  );
}
