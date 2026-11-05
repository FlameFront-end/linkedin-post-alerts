import { z } from 'zod';

const positiveInt = z.coerce.number().int().positive();
const schema = z
  .object({
    DATABASE_URL: z.string().min(1),
    SOURCE_MODE: z.enum(['mock', 'linkedin']).default('mock'),
    LINKEDIN_CONFIG_FILE: z.string().min(1).default('.local/linkedin.json'),
    POLL_INTERVAL_MS: positiveInt.min(1000).default(180000),
    WORKER_INTERVAL_MS: positiveInt.min(100).default(1000),
    COLLECTOR_PORT: positiveInt.max(65535).default(3101),
    PROCESSOR_PORT: positiveInt.max(65535).default(3102),
    NOTIFIER_PORT: positiveInt.max(65535).default(3103),
    TELEGRAM_MODE: z.enum(['dry-run', 'live']).default('dry-run'),
    TELEGRAM_BOT_TOKEN: z.string().default(''),
    TELEGRAM_CHAT_ID: z.string().default(''),
    PREFER_RUSSIAN: z
      .enum(['true', 'false'])
      .default('true')
      .transform((v) => v === 'true'),
  })
  .superRefine((value, ctx) => {
    if (
      value.TELEGRAM_MODE === 'live' &&
      (!value.TELEGRAM_BOT_TOKEN || !value.TELEGRAM_CHAT_ID)
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'Live Telegram requires token and chat ID',
      });
    }
    if (value.TELEGRAM_MODE === 'live' && value.SOURCE_MODE === 'mock') {
      ctx.addIssue({
        code: 'custom',
        message: 'Refusing live Telegram with mock source',
      });
    }
  });
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const parsed = schema.safeParse(env);
  if (!parsed.success)
    throw new Error(
      `Invalid configuration: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  return parsed.data;
}
