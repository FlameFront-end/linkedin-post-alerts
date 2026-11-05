import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createPool } from '../../packages/runtime/src/db.js';
import {
  claim,
  complete,
  enqueue,
  fail,
  replayDead,
} from '../../packages/queue/src/index.js';
import { TelegramSender } from '../../services/notifier/src/sender.js';
import { collect } from '../../services/collector/src/collect.js';
import { MockSource } from '../../services/collector/src/sources/mock.js';
import { processNext } from '../../services/processor/src/process.js';
import { deliverNext } from '../../services/notifier/src/deliver.js';

const url = process.env.TEST_DATABASE_URL;
test(
  'Durable pipeline, deduplication, leases and retries',
  { skip: !url },
  async () => {
    if (!url) return;
    if (!new URL(url).pathname.endsWith('_test'))
      throw new Error('Integration database name must end with _test');
    if (url === process.env.DATABASE_URL)
      throw new Error('Test DB must differ from application DB');
    const pool = createPool(url);
    try {
      await pool.query(
        'DROP SCHEMA IF EXISTS queue CASCADE; DROP SCHEMA IF EXISTS processing CASCADE',
      );
      await pool.query(
        await readFile(
          new URL('../../migrations/001_initial.sql', import.meta.url),
          'utf8',
        ),
      );
      const source = new MockSource();
      await collect(source, pool);
      await collect(source, pool);
      assert.equal(
        (await pool.query('SELECT count(*)::int AS n FROM queue.jobs')).rows[0]
          .n,
        3,
      );
      while (await processNext(pool)) {
        /* drain */
      }
      const messages: string[] = [];
      while (
        await deliverNext(
          pool,
          {
            send: async (text) => {
              messages.push(text);
            },
          },
          true,
        )
      ) {
        /* drain */
      }
      assert.equal(messages.length, 2);
      await collect(source, pool);
      assert.equal(await processNext(pool), false);
      assert.equal(
        await deliverNext(
          pool,
          { send: async () => assert.fail('duplicate') },
          true,
        ),
        false,
      );

      await enqueue(pool, 'post', 'lease-test', {});
      const claims = await Promise.all([
        claim(pool, 'post'),
        claim(pool, 'post'),
      ]);
      assert.equal(claims.filter(Boolean).length, 1);
      const first = claims.find(Boolean)!;
      await pool.query(
        "UPDATE queue.jobs SET locked_until=now()-interval '1 second' WHERE id=$1",
        [first.id],
      );
      const second = (await claim(pool, 'post'))!;
      assert.notEqual(first.lock_token, second.lock_token);
      await assert.rejects(complete(pool, first));
      await fail(pool, second, { permanent: true });
      assert.equal(
        (
          await pool.query('SELECT status FROM queue.jobs WHERE id=$1', [
            first.id,
          ])
        ).rows[0].status,
        'dead',
      );

      await enqueue(pool, 'notification', 'retry-test', {
        post: (await source.fetchPosts())[0],
        roles: ['frontend'],
        russian: true,
      });
      await deliverNext(
        pool,
        {
          send: async () => {
            throw new Error('network down');
          },
        },
        true,
      );
      const retry = (
        await pool.query(
          "SELECT status,attempts FROM queue.jobs WHERE dedupe_key='retry-test'",
        )
      ).rows[0];
      assert.equal(retry.status, 'pending');
      assert.equal(retry.attempts, 1);
      await pool.query(
        "UPDATE queue.jobs SET available_at=now() WHERE dedupe_key='retry-test'",
      );
      assert.equal(
        await deliverNext(pool, { send: async () => {} }, true),
        true,
      );

      // Misconfigured token must preserve the current job AND untouched backlog.
      const payload = {
        post: (await source.fetchPosts())[0],
        roles: ['frontend'],
        russian: true,
      };
      await enqueue(pool, 'notification', 'blocked-one', payload);
      await enqueue(pool, 'notification', 'blocked-two', payload);
      const originalFetch = globalThis.fetch;
      let sends = 0;
      const blocked = new TelegramSender('NOT_A_TOKEN', 'NOT_A_CHAT');
      globalThis.fetch = async () => {
        sends++;
        return new Response('{"ok":false}', { status: 401 });
      };
      try {
        assert.equal(await deliverNext(pool, blocked, true), false);
        assert.equal(await deliverNext(pool, blocked, true), false);
        assert.equal(sends, 1);
      } finally {
        globalThis.fetch = originalFetch;
      }
      const blockedRows = (
        await pool.query(
          "SELECT status, attempts FROM queue.jobs WHERE dedupe_key IN ('blocked-one','blocked-two')",
        )
      ).rows;
      assert.ok(
        blockedRows.every(
          (row) => row.status === 'pending' && row.attempts === 0,
        ),
      );
      while (await deliverNext(pool, { send: async () => {} }, true)) {}

      // Acknowledgement transient failures retry only the DB operation, never send twice.
      await pool.query(`CREATE SEQUENCE processing.ack_attempts;
        CREATE FUNCTION processing.fail_ack_twice() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.status='done' AND OLD.dedupe_key='ack-test' AND nextval('processing.ack_attempts') <= 2
          THEN RAISE EXCEPTION 'simulated unavailable acknowledgement'; END IF; RETURN NEW; END $$;
        CREATE TRIGGER fail_ack BEFORE UPDATE ON queue.jobs FOR EACH ROW EXECUTE FUNCTION processing.fail_ack_twice()`);
      await enqueue(pool, 'notification', 'ack-test', payload);
      let ackSends = 0;
      assert.equal(
        await deliverNext(
          pool,
          {
            send: async () => {
              ackSends++;
            },
          },
          true,
        ),
        true,
      );
      assert.equal(ackSends, 1);
      assert.equal(
        (
          await pool.query(
            "SELECT status FROM queue.jobs WHERE dedupe_key='ack-test'",
          )
        ).rows[0].status,
        'done',
      );
      assert.equal(await replayDead(pool, 'post', first.id), true);
      assert.equal(await replayDead(pool, 'post', first.id), false);
    } finally {
      await pool.end();
    }
  },
);
