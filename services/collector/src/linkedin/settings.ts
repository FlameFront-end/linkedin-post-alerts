import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { LinkedInError } from './errors.js';

const cookie = z
  .string()
  .min(1)
  .max(8192)
  .regex(/^[^;\r\n]+$/);
const sessionSchema = z.object({
  liAt: cookie,
  jsessionId: cookie,
  csrfToken: cookie.optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const settingsSchema = z
  .object({
    sessionFile: z.string().min(1),
    authorUrns: z
      .array(z.string().regex(/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/))
      .max(50)
      .default([]),
    keywords: z.array(z.string().min(1).max(300)).max(20).default([]),
    searchPathTemplate: z.string().max(8000).optional(),
    pageSize: z.number().int().min(1).max(50).default(10),
    maxPages: z.number().int().min(1).max(10).default(2),
    maxAgeHours: z.number().min(1).max(168).default(24),
    requestIntervalMs: z.number().int().min(1000).max(60000).default(2000),
  })
  .superRefine((value, ctx) => {
    if (!value.authorUrns.length && !value.keywords.length)
      ctx.addIssue({
        code: 'custom',
        message: 'At least one author or keyword is required',
      });
    if (value.keywords.length && !value.searchPathTemplate)
      ctx.addIssue({
        code: 'custom',
        message: 'Keyword search requires a captured searchPathTemplate',
      });
    if (
      value.searchPathTemplate &&
      !['{keywords}', '{start}', '{count}'].every((p) =>
        value.searchPathTemplate!.includes(p),
      )
    )
      ctx.addIssue({ code: 'custom', message: 'Missing search placeholders' });
  });
export type Settings = z.infer<typeof settingsSchema>;
export async function loadSettings(
  path: string,
): Promise<Settings & { session: Session }> {
  try {
    const settings = settingsSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    const sessionPath = resolve(dirname(path), settings.sessionFile);
    const info = await stat(sessionPath);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new Error('Session file must have mode 600');
    const session = sessionSchema.parse(
      JSON.parse(await readFile(sessionPath, 'utf8')),
    );
    return { ...settings, session };
  } catch {
    throw new LinkedInError('configuration');
  }
}
