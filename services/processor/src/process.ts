import type pg from 'pg';
import { enrichImages } from './ocr.js';
import {
  contentFingerprint,
  sourceAlias,
} from '../../../packages/contracts/src/fingerprint.js';
import { postSchema } from '../../../packages/contracts/src/index.js';
import {
  claim,
  complete,
  enqueue,
  fail,
} from '../../../packages/queue/src/index.js';
import { transaction } from '../../../packages/runtime/src/db.js';
import { log, errorFields } from '../../../packages/runtime/src/logger.js';
import {
  classifyPost,
  assessedCandidates,
} from '../../../packages/contracts/src/classifier.js';
import { recordVacancy } from './vacancies.js';

export async function processNext(
  pool: pg.Pool,
  filterVacancies = false,
): Promise<boolean> {
  const job = await claim(pool, 'post');
  if (!job) return false;
  const started = Date.now();
  log('processor', 'job_claimed', { jobId: job.id, attempt: job.attempts });
  const parsed = postSchema.safeParse(job.payload);
  if (!parsed.success) {
    await fail(pool, job, { permanent: true });
    log('processor', 'invalid_job', { jobId: job.id });
    return true;
  }
  try {
    const rawPost = parsed.data;
    const enriched = filterVacancies ? await enrichImages(rawPost) : rawPost;
    const post =
      enriched === rawPost
        ? rawPost
        : { ...enriched, sourceFingerprint: contentFingerprint(rawPost) };
    const decision = classifyPost(post);
    await transaction(pool, async (db) => {
      const latest = (
        await db.query(
          'SELECT fingerprint FROM processing.observations WHERE id=$1 FOR UPDATE',
          [post.id],
        )
      ).rows[0];
      if (
        latest &&
        latest.fingerprint !==
          (rawPost.sourceFingerprint ?? contentFingerprint(rawPost))
      ) {
        await complete(db, job);
        log('processor', 'stale_version_skipped', {
          jobId: job.id,
          postId: post.id,
        });
        return;
      }
      await db.query(
        `INSERT INTO processing.posts(id,payload,roles,russian,decision,language,language_evidence,assessment) VALUES($1,$2,$3,$4,$5,$6,$7,$8)
        ON CONFLICT(id) DO UPDATE SET payload=excluded.payload,roles=excluded.roles,russian=excluded.russian,decision=excluded.decision,language=excluded.language,language_evidence=excluded.language_evidence,assessment=excluded.assessment,processed_at=now()`,
        [
          post.id,
          JSON.stringify(post),
          decision.roles,
          decision.russian,
          decision.reason,
          decision.language,
          decision.evidence ?? null,
          JSON.stringify(
            assessedCandidates(post).map((candidate) => candidate.decision),
          ),
        ],
      );
      if (filterVacancies) {
        const candidates = assessedCandidates(post);
        for (const candidate of candidates) {
          const queued = await recordVacancy(
            db,
            candidate.post,
            candidate.decision,
          );
          log('processor', 'candidate_decision', {
            jobId: job.id,
            postId: post.id,
            decision: candidate.decision.reason,
            language: candidate.decision.language,
            roles: candidate.decision.roles.join(','),
            notificationQueued: queued,
          });
        }
        if (!post.textIncomplete) {
          const active = candidates
            .filter(
              (candidate) =>
                candidate.decision.reason === 'matched' &&
                candidate.decision.language !== 'none',
            )
            .map((candidate) => sourceAlias(candidate.post));
          await db.query(
            `UPDATE processing.vacancies v SET status='closed',last_seen_at=now()
            WHERE v.payload->>'id'=$1 AND EXISTS (SELECT 1 FROM processing.vacancy_aliases a WHERE a.vacancy_id=v.id AND starts_with(a.alias,$2) ) AND NOT EXISTS (SELECT 1 FROM processing.vacancy_aliases a WHERE a.vacancy_id=v.id AND a.alias=ANY($3::text[]))`,
            [post.id, `source:${post.id}:`, active],
          );
        }
      } else if (decision.roles.length)
        await enqueue(db, 'notification', post.id, {
          post,
          roles: decision.roles,
          russian: decision.russian,
        });
      await complete(db, job);
    });
    log('processor', 'post_processed', {
      jobId: job.id,
      decision: decision.reason,
      postId: post.id,
      language: decision.language,
      roles: decision.roles.join(','),
      durationMs: Date.now() - started,
    });
  } catch (error) {
    log(
      'processor',
      'processing_failed',
      { jobId: job.id, ...errorFields(error) },
      'error',
    );
    await fail(pool, job);
    log('processor', 'job_retry', { jobId: job.id, attempt: job.attempts });
  }
  return true;
}
