import {
  classifyPost,
  vacancyRoles,
} from '../../../packages/contracts/src/classifier.js';
import type pg from 'pg';
import { staleAlert } from './alert-freshness.js';
import { transaction } from '../../../packages/runtime/src/db.js';
import type { Post } from '../../../packages/contracts/src/index.js';
import {
  alertSchema,
  notificationSchema,
} from '../../../packages/contracts/src/index.js';
import {
  claim,
  complete,
  fail,
  release,
} from '../../../packages/queue/src/index.js';
import { DeliveryError, type Sender } from './sender.js';
import { log, errorFields } from '../../../packages/runtime/src/logger.js';
import { formatAlert, formatNotification } from './format.js';

export async function deliverNext(
  pool: pg.Pool,
  sender: Sender,
  preferRussian: boolean,
  filterVacancies = false,
) {
  if (sender.isReady && !sender.isReady()) return false;
  // Owner alerts (collection stopped) go before vacancies.
  let job = await claim(pool, 'alert');
  let text: string | undefined;
  let deliveredPost: Post | undefined;
  const vacancy = !job;
  if (job) {
    const alert = alertSchema.safeParse(job.payload);
    if (alert.success && staleAlert(alert.data)) {
      await complete(pool, job);
      log('notifier', 'stale_alert_skipped', { jobId: job.id });
      return true;
    }
    if (alert.success) text = formatAlert(alert.data);
  } else {
    job = await claim(pool, 'notification');
    if (!job) return false;
    const parsed = notificationSchema.safeParse(job.payload);
    if (parsed.success) {
      const value = parsed.data;
      deliveredPost = value.post;
      if (value.vacancyId) {
        const current = (
          await pool.query(
            'SELECT revision,status FROM processing.vacancies WHERE id=$1',
            [value.vacancyId],
          )
        ).rows[0];
        if (
          !current ||
          current.status !== 'open' ||
          current.revision !== value.revision
        ) {
          await complete(pool, job);
          log('notifier', 'superseded_notification', { jobId: job.id });
          return true;
        }
      }
      const roles = filterVacancies
        ? vacancyRoles(classifyPost(value.post))
        : value.roles;
      if (!roles.length) {
        await complete(pool, job);
        log('notifier', 'vacancy_filtered', { jobId: job.id });
        return true;
      }
      text = formatNotification({ ...value, roles }, preferRussian, true);
    }
  }
  log('notifier', 'delivery_claimed', {
    jobId: job.id,
    kind: vacancy ? 'notification' : 'alert',
    attempt: job.attempts,
  });
  if (text === undefined) {
    await fail(pool, job, { permanent: true });
    return true;
  }
  const receipt = await pool.query(
    'SELECT 1 FROM processing.deliveries WHERE job_id=$1',
    [job.id],
  );
  if (receipt.rowCount) {
    log('notifier', 'receipt_found', { jobId: job.id });
    await complete(pool, job);
    return true;
  }
  const started = Date.now();
  try {
    log('notifier', 'delivery_started', { jobId: job.id, chars: text.length });
    await sender.send(text, vacancy ? 'HTML' : undefined);
  } catch (error) {
    log(
      'notifier',
      'delivery_failed',
      {
        jobId: job.id,
        durationMs: Date.now() - started,
        ...errorFields(error),
        blocked: error instanceof DeliveryError && error.blocked,
        retrySeconds:
          error instanceof DeliveryError ? error.retryAfterSeconds : undefined,
      },
      'warn',
    );
    if (error instanceof DeliveryError && error.blocked) {
      await release(pool, job);
      log('notifier', 'delivery_paused', { jobId: job.id });
      return false;
    }
    const options: { permanent?: boolean; delaySeconds?: number } = {};
    if (error instanceof DeliveryError) {
      options.permanent = error.permanent;
      if (error.retryAfterSeconds !== undefined)
        options.delaySeconds = error.retryAfterSeconds;
    }
    await fail(pool, job, options);
    return true;
  }
  const sentAt = new Date().toISOString();
  log('notifier', 'delivery_sent', {
    jobId: job.id,
    durationMs: Date.now() - started,
  });
  // Retry acknowledgement only; never immediately resend an already sent message.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await transaction(pool, async (db) => {
        await db.query(
          'INSERT INTO processing.deliveries(job_id,sent_at,detected_at,published_at,published_precision) VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING',
          [
            job.id,
            sentAt,
            deliveredPost?.firstSeenAt ?? null,
            deliveredPost?.publishedAt ?? null,
            deliveredPost?.publishedPrecision ?? 'instant',
          ],
        );
        await complete(db, job);
      });
      log('notifier', 'delivery_committed', { jobId: job.id });
      return true;
    } catch (error) {
      log(
        'notifier',
        'ack_retry',
        { jobId: job.id, attempt: attempt + 1, ...errorFields(error) },
        'warn',
      );
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  log('notifier', 'delivered_not_committed', { jobId: job.id });
  // Lease expiry can still cause a duplicate. This is at-least-once delivery.
  return false;
}
