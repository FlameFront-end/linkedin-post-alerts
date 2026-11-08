import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { createPool } from '../../packages/runtime/src/db.js';
import { collect } from '../../services/collector/src/collect.js';
import { processNext } from '../../services/processor/src/process.js';
import { deliverNext } from '../../services/notifier/src/deliver.js';
import type { Post } from '../../packages/contracts/src/index.js';
const url = process.env.TEST_FUNCTIONAL_DATABASE_URL;
test(
  'Vacancy revisions, cross-source duplicates, roundups and stale queue versions',
  { skip: !url },
  async () => {
    if (
      !url ||
      !new URL(url).pathname.endsWith('_test') ||
      url === process.env.DATABASE_URL ||
      url === process.env.TEST_DATABASE_URL
    )
      throw new Error('Separate functional test database required');
    const pool = createPool(url);
    try {
      await pool.query(
        'DROP SCHEMA IF EXISTS queue CASCADE; DROP SCHEMA IF EXISTS processing CASCADE',
      );
      const directory = new URL('../../migrations/', import.meta.url);
      for (const name of (await readdir(directory))
        .filter((n) => n.endsWith('.sql'))
        .sort())
        await pool.query(await readFile(new URL(name, directory), 'utf8'));
      const now = Date.now();
      let seen = 0;
      const make = (
        id: string,
        text: string,
        extra: Partial<Post> = {},
      ): Post => ({
        id,
        text,
        url: 'https://www.linkedin.com/feed/update/urn:li:activity:123/',
        author: 'Recruiter',
        publishedAt: new Date(now).toISOString(),
        firstSeenAt: new Date(now + seen++).toISOString(),
        ...extra,
      });
      const source = (posts: Post[]) => ({
        name: 'offline',
        fetchPosts: async () => posts,
      });
      const process = async () => {
        while (await processNext(pool, true)) {}
      };
      const notifications = async () =>
        (
          await pool.query(
            "SELECT payload FROM queue.jobs WHERE kind='notification' ORDER BY id",
          )
        ).rows;
      const original = make(
        'edited',
        'Ищем frontend разработчика в нашу команду. Удаленная работа, зарплата 3000 USD.',
      );
      assert.equal(await collect(source([original]), pool), 1);
      assert.equal(await collect(source([original]), pool), 0);
      const edited = make('edited', original.text.replace('3000', '4000'));
      assert.equal(await collect(source([edited]), pool), 1);
      await process();
      assert.equal((await notifications()).length, 1);
      assert.match((await notifications())[0]!.payload.post.text, /4000/);
      const secondEdit = make('edited', edited.text.replace('4000', '5000'));
      await collect(source([secondEdit]), pool);
      await process();
      assert.equal((await notifications()).length, 2);
      const delivered: string[] = [];
      while (
        await deliverNext(
          pool,
          {
            send: async (text) => {
              delivered.push(text);
            },
          },
          true,
          true,
        )
      ) {}
      assert.equal(delivered.length, 1);
      assert.match(delivered[0]!, /5000/);
      assert.match(delivered[0]!, /Обновлено/);

      const a = make(
        'cross-post',
        'Ищем Frontend разработчика в нашу команду. Удаленная работа. Отклик https://www.linkedin.com/jobs/view/12345678/',
      );
      const b = make(
        'urn:li:jobPosting:12345678',
        'Ищем frontend инженера в команду продукта. Предлагаем удаленную работу и гибкие условия.',
        { kind: 'job', title: 'Frontend Engineer' },
      );
      await collect(source([a, b]), pool);
      await Promise.all([processNext(pool, true), processNext(pool, true)]);
      const afterMerge = (await notifications()).length;
      assert.equal(afterMerge, 3);
      // Alternate source with unchanged text must not toggle the canonical revision.
      await collect(
        source([{ ...b, firstSeenAt: new Date(now + seen++).toISOString() }]),
        pool,
      );
      await process();
      assert.equal((await notifications()).length, afterMerge);

      const roundup = make(
        'roundup',
        'Ищем разработчиков в нашу команду.\nBackend: вакансия закрыта.\nFrontend: открыта позиция, удаленная работа, опыт от трех лет.\nFullstack: ищем разработчика, предлагаем гибкие условия и интересные задачи.',
      );
      await collect(source([roundup]), pool);
      await process();
      assert.equal((await notifications()).length, afterMerge + 2);
      const candidate = make(
        'roundup',
        'Frontend разработчик, рассматриваю вакансии. Есть опыт работы в продуктовой команде, готов обсудить условия и задачи.',
      );
      await collect(source([candidate]), pool);
      await process();
      assert.equal((await notifications()).length, afterMerge + 2);
      const assessment = (
        await pool.query(
          "SELECT decision,language FROM processing.posts WHERE id='roundup'",
        )
      ).rows[0];
      assert.equal(assessment.decision, 'candidate');
      assert.equal(assessment.language, 'russian');

      const closing = make(
        'close-test',
        'Ищем frontend разработчика в нашу команду. Удаленная работа и интересные задачи.',
      );
      await collect(source([closing]), pool);
      await process();
      const closed = make(
        'close-test',
        'Вакансия закрыта. Ищем frontend разработчика в нашу команду. Удаленная работа и интересные задачи.',
      );
      await collect(source([closed]), pool);
      await process();
      const stale: string[] = [];
      while (
        await deliverNext(
          pool,
          {
            send: async (text) => {
              stale.push(text);
            },
          },
          true,
          true,
        )
      ) {}
      assert.ok(!stale.some((text) => text.includes('Вакансия закрыта')));
      assert.equal(
        (
          await pool.query(
            "SELECT count(*)::int AS n FROM processing.vacancies WHERE payload->>'id'='close-test' AND status='closed'",
          )
        ).rows[0].n,
        1,
      );
      // Two collector processes cannot each spend the same last quota slot.
      const { TrafficProtection, protectionPolicySchema } =
        await import('../../services/collector/src/linkedin/protection.js');
      const { DatabaseProtectionStore } =
        await import('../../services/collector/src/linkedin/protection-store.js');
      const policy = protectionPolicySchema.parse({ hourlyRequests: 1 });
      const guardA = new TrafficProtection(
        new DatabaseProtectionStore(pool),
        policy,
      );
      const guardB = new TrafficProtection(
        new DatabaseProtectionStore(pool),
        policy,
      );
      let physicalRequests = 0;
      const reservations = await Promise.allSettled([
        guardA.run('feed', async () => {
          physicalRequests++;
        }),
        guardB.run('jobs', async () => {
          physicalRequests++;
        }),
      ]);
      assert.equal(physicalRequests, 1);
      assert.equal(
        reservations.filter((result) => result.status === 'fulfilled').length,
        1,
      );
      const restarted = new TrafficProtection(
        new DatabaseProtectionStore(pool),
        policy,
      );
      assert.equal((await restarted.snapshot()).events.length, 1);
    } finally {
      await pool.end();
    }
  },
);
