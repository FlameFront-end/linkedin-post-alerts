import type pg from 'pg';
import { notificationSchema } from '../../../packages/contracts/src/index.js';
import { claim, complete, fail } from '../../../packages/queue/src/index.js';
import { DeliveryError, type Sender } from './sender.js';
import { formatNotification } from './format.js';

export async function deliverNext(
  pool: pg.Pool,
  sender: Sender,
  preferRussian: boolean,
) {
  const job = await claim(pool, 'notification');
  if (!job) return false;
  const parsed = notificationSchema.safeParse(job.payload);
  if (!parsed.success) {
    await fail(pool, job, { permanent: true });
    return true;
  }
  try {
    await sender.send(formatNotification(parsed.data, preferRussian));
    await complete(pool, job);
  } catch (error) {
    const options: { permanent?: boolean; delaySeconds?: number } = {};
    if (error instanceof DeliveryError) {
      options.permanent = error.permanent;
      if (error.retryAfterSeconds !== undefined)
        options.delaySeconds = error.retryAfterSeconds;
    }
    await fail(pool, job, options);
  }
  return true;
}
