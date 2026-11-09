import { log } from '../../../packages/runtime/src/logger.js';
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { Post } from '../../../packages/contracts/src/index.js';
import type { Classification } from '../../../packages/contracts/src/classifier.js';
import { vacancyRoles } from '../../../packages/contracts/src/classifier.js';
import {
  contentFingerprint,
  sourceAlias,
  vacancyAliases,
} from '../../../packages/contracts/src/fingerprint.js';
import { enqueue } from '../../../packages/queue/src/index.js';

export async function recordVacancy(
  db: pg.PoolClient,
  post: Post,
  decision: Classification,
): Promise<boolean> {
  const aliases = vacancyAliases(post);
  for (const alias of aliases)
    await db.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      alias,
    ]);
  const existing = (
    await db.query<{ id: string; revision: string; status: string }>(
      `SELECT v.id,v.revision,v.status FROM processing.vacancies v JOIN processing.vacancy_aliases a ON a.vacancy_id=v.id WHERE a.alias=ANY($1::text[]) ORDER BY (a.alias=$2) DESC,v.first_seen_at LIMIT 1 FOR UPDATE OF v`,
      [aliases, sourceAlias(post)],
    )
  ).rows[0];
  const roles = vacancyRoles(decision);
  if (!roles.length) {
    if (
      existing &&
      !post.textIncomplete &&
      (
        await db.query(
          'SELECT 1 FROM processing.vacancy_aliases WHERE alias=$1 AND vacancy_id=$2',
          [sourceAlias(post), existing.id],
        )
      ).rowCount
    )
      await db.query(
        "UPDATE processing.vacancies SET status='closed', last_seen_at=now() WHERE id=$1",
        [existing.id],
      );
    return false;
  }
  const id = existing?.id ?? randomUUID();
  const revision = contentFingerprint(post);
  // Reposts that add prose but link the same job are alternate sources, not edits.
  const source = existing
    ? (
        await db.query<{ fingerprint: string }>(
          'SELECT fingerprint FROM processing.vacancy_aliases WHERE alias=$1 AND vacancy_id=$2',
          [sourceAlias(post), id],
        )
      ).rows[0]
    : undefined;
  const changed =
    !existing ||
    (!!source &&
      (source.fingerprint !== revision || existing.status !== 'open'));
  await db.query(
    `INSERT INTO processing.vacancies(id,revision,payload) VALUES($1,$2,$3) ON CONFLICT(id) DO UPDATE SET last_seen_at=now(), revision=CASE WHEN $4 THEN excluded.revision ELSE processing.vacancies.revision END, payload=CASE WHEN $4 THEN excluded.payload ELSE processing.vacancies.payload END, status=CASE WHEN $4 THEN 'open' ELSE processing.vacancies.status END`,
    [id, revision, JSON.stringify(post), changed],
  );
  for (const alias of aliases)
    await db.query(
      'INSERT INTO processing.vacancy_aliases(alias,vacancy_id,fingerprint) VALUES($1,$2,$3) ON CONFLICT(alias) DO NOTHING',
      [alias, id, revision],
    );
  await db.query(
    'UPDATE processing.vacancy_aliases SET fingerprint=$1 WHERE alias=$2 AND vacancy_id=$3',
    [revision, sourceAlias(post), id],
  );
  await db.query(
    'INSERT INTO processing.vacancy_revisions(vacancy_id,revision,payload) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [id, revision, JSON.stringify(post)],
  );
  if (!changed) {
    log('processor', 'vacancy_duplicate', { postId: post.id, vacancyId: id });
    return false;
  }
  // Seed the new ledger from legacy delivered notifications without resending them.
  const legacy =
    !existing &&
    (
      await db.query(
        "SELECT 1 FROM queue.jobs WHERE kind='notification' AND dedupe_key=$1 AND status='done' AND payload->'post'->>'text'=$2",
        [post.id, post.text],
      )
    ).rowCount === 1;
  if (legacy) {
    log('processor', 'legacy_delivery_preserved', {
      postId: post.id,
      vacancyId: id,
    });
    return false;
  }
  log('processor', 'vacancy_revision', {
    postId: post.id,
    vacancyId: id,
    revision: revision.slice(0, 16),
    updated: !!existing,
  });
  return enqueue(db, 'notification', `${id}:${revision}`, {
    post,
    roles,
    russian: decision.russian,
    vacancyId: id,
    revision,
    updated: !!existing,
  });
}
