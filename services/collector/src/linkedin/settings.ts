import { readFile, stat } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { z } from 'zod';
import { protectionPolicySchema } from './protection.js';
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
  userAgent: z
    .string()
    .min(1)
    .max(1000)
    .regex(/^[^\r\n]+$/)
    .optional(),
});
export type Session = z.infer<typeof sessionSchema>;
export const settingsSchema = z
  .object({
    protection: protectionPolicySchema.default(() =>
      protectionPolicySchema.parse({}),
    ),
    sessionFile: z.string().min(1),
    jobsKeywords: z.array(z.string().min(1).max(300)).max(12).default([]),
    jobsIntervalMs: z.number().int().min(300000).max(86400000).default(900000),
    jobsMaxAgeHours: z.number().int().min(24).max(168).default(168),
    jobsDetailsPerQuery: z.number().int().min(1).max(3).default(3),
    jobsMaxPages: z.number().int().min(1).max(5).default(2),
    jobsRequestBudget: z.number().int().min(4).max(30).default(10),
    personalFeed: z.boolean().default(false),
    personalFeedLoadMore: z.number().int().min(0).max(20).default(2),
    authorUrns: z
      .array(z.string().regex(/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/))
      .max(50)
      .default([]),
    keywords: z.array(z.string().min(1).max(300)).max(20).default([]),
    searchPathTemplate: z.string().max(8000).optional(),
    // Obsolete: accepted so old local configs still load. Has no effect.
    experimentalKeywordSearch: z.boolean().optional(),
    postPathTemplate: z
      .string()
      .max(8000)
      .default('/voyager/api/feed/updates/{urn}'),
    maxDetailsPerQuery: z.number().int().min(1).max(100).default(8),
    maxRequestsPerCycle: z.number().int().min(1).max(500).default(30),
    pageSize: z.number().int().min(1).max(50).default(10),
    maxPages: z.number().int().min(1).max(10).default(1),
    maxAgeHours: z.number().min(1).max(168).default(24),
    requestIntervalMs: z.number().int().min(1000).max(60000).default(3000),
  })
  .superRefine((value, ctx) => {
    if (
      value.personalFeed &&
      (value.keywords.length || value.authorUrns.length) &&
      value.maxRequestsPerCycle < 2
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Feed plus search requires a request budget of at least 2',
      });
    if (
      !value.personalFeed &&
      !value.jobsKeywords.length &&
      !value.authorUrns.length &&
      !value.keywords.length
    )
      ctx.addIssue({
        code: 'custom',
        message: 'At least one author or keyword is required',
      });
    if (value.keywords.length && !value.searchPathTemplate)
      ctx.addIssue({
        code: 'custom',
        message:
          'Global post search needs a current captured Posts request; see docs/GLOBAL_SEARCH.md',
      });
    if (
      !value.postPathTemplate.includes('{urn}') &&
      !value.postPathTemplate.includes('{slug}')
    )
      ctx.addIssue({
        code: 'custom',
        message: 'Post request requires urn or slug placeholder',
      });
    if (
      value.searchPathTemplate &&
      !(
        value.searchPathTemplate.startsWith('/search/results/content/?')
          ? ['{keywords}']
          : ['{keywords}', '{start}', '{count}']
      ).every((p) => value.searchPathTemplate!.includes(p))
    )
      ctx.addIssue({ code: 'custom', message: 'Missing search placeholders' });
  });
export type Settings = z.infer<typeof settingsSchema>;
export async function loadSettings(
  path: string,
): Promise<Settings & { session: Session }> {
  let phase = 'settings_read';
  try {
    const settings = settingsSchema.parse(
      JSON.parse(await readFile(path, 'utf8')),
    );
    phase = 'session_read';
    const sessionPath = resolve(dirname(path), settings.sessionFile);
    const info = await stat(sessionPath);
    if (process.platform !== 'win32' && (info.mode & 0o077) !== 0)
      throw new LinkedInError('configuration', 60, 'session_permissions');
    const session = sessionSchema.parse(
      JSON.parse(await readFile(sessionPath, 'utf8')),
    );
    return { ...settings, session };
  } catch (error) {
    if (error instanceof LinkedInError) throw error;
    const reason =
      error instanceof z.ZodError ? phase.replace('_read', '_schema') : phase;
    throw new LinkedInError('configuration', 60, reason);
  }
}
