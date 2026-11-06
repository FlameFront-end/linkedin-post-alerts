import {
  classify,
  vacancyRoles,
} from '../../../packages/contracts/src/classifier.js';
import type pg from 'pg';
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
import { log } from '../../../packages/runtime/src/logger.js';
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
  const vacancy = !job;
  if (job) {
    const alert = alertSchema.safeParse(job.payload);
    if (alert.success) text = formatAlert(alert.data);
  } else {
    job = await claim(pool, 'notification');
    if (!job) return false;
    const parsed = notificationSchema.safeParse(job.payload);
    if (parsed.success) {
      const value = parsed.data;
      const roles = filterVacancies
        ? vacancyRoles(classify(value.post.text))
        : value.roles;
      if (!roles.length) {
        await complete(pool, job);
        log('notifier', 'vacancy_filtered', { jobId: job.id });
        return true;
      }
      text = formatNotification({ ...value, roles }, preferRussian, true);
    }
  }
  if (text === undefined) {
    await fail(pool, job, { permanent: true });
    return true;
  }
  try {
    await sender.send(text, vacancy ? 'HTML' : undefined);
  } catch (error) {
    if (error instanceof DeliveryError && error.blocked) {
      await release(pool, job);
      log('notifier', 'delivery_configuration_blocked', { jobId: job.id });
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
  // Retry acknowledgement only; never immediately resend an already sent message.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await complete(pool, job);
      return true;
    } catch {
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 250));
    }
  }
  log('notifier', 'delivered_not_committed', { jobId: job.id });
  // Lease expiry can still cause a duplicate. This is at-least-once delivery.
  return false;
}
