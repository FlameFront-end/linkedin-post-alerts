import { z } from 'zod';

export const postSchema = z.object({
  id: z.string().min(1).max(200),
  url: z
    .url()
    .max(1000)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        (url.hostname === 'linkedin.com' ||
          url.hostname.endsWith('.linkedin.com'))
      );
    }, 'Expected HTTPS LinkedIn URL'),
  text: z.string().min(1).max(100_000),
  author: z.string().min(1).max(500),
  publishedAt: z.iso.datetime(),
  firstSeenAt: z.iso.datetime(),
});
export type Post = z.infer<typeof postSchema>;
export const roleSchema = z.enum(['frontend', 'fullstack', 'devops']);
export type Role = z.infer<typeof roleSchema>;
export const notificationSchema = z.object({
  post: postSchema,
  roles: z.array(roleSchema).min(1),
  russian: z.boolean(),
});
export type Notification = z.infer<typeof notificationSchema>;
// Operational alerts for the owner (collection stopped, session expired, throttling).
export const alertSchema = z.object({
  source: z.enum(['collector']),
  code: z.string().min(1).max(64),
  message: z.string().min(1).max(1000),
  at: z.iso.datetime(),
});
export type Alert = z.infer<typeof alertSchema>;
export type JobKind = 'post' | 'notification' | 'alert';
