import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  TelegramSender,
  DeliveryError,
} from '../services/notifier/src/sender.js';
import { formatNotification } from '../services/notifier/src/format.js';
import { MockSource } from '../services/collector/src/sources/mock.js';

test('Telegram honors rate-limit retry_after without leaking token', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(
      JSON.stringify({ ok: false, parameters: { retry_after: 23 } }),
      { status: 429 },
    );
  try {
    const sender = new TelegramSender('SECRET', '1');
    await assert.rejects(
      sender.send('test'),
      (error: unknown) =>
        error instanceof DeliveryError &&
        !error.permanent &&
        error.retryAfterSeconds === 23 &&
        !error.message.includes('SECRET'),
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('Telegram access failure pauses sender instead of killing messages', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () => new Response('{"ok":false}', { status: 403 });
  try {
    await assert.rejects(
      new TelegramSender('SECRET', '1').send('test'),
      (error: unknown) =>
        error instanceof DeliveryError && error.blocked && !error.permanent,
    );
  } finally {
    globalThis.fetch = original;
  }
});
test('Long text preserves the source link and stays below Telegram limit', async () => {
  const post = (await new MockSource().fetchPosts())[0]!;
  const text = formatNotification(
    {
      post: { ...post, text: '<script>' + 'x'.repeat(10000) },
      roles: ['frontend'],
      russian: true,
    },
    true,
  );
  assert.ok(text.length <= 4096);
  assert.ok(text.endsWith(post.url));
});

test('Telegram card escapes post text and labels the source link', async () => {
  const post = (await new MockSource().fetchPosts())[0]!;
  const text = formatNotification(
    {
      post: {
        ...post,
        text: 'Ищем <React> разработчика\n\nОпыт & условия\n#React #Работа',
      },
      roles: ['frontend'],
      russian: true,
    },
    true,
    true,
  );
  assert.match(text, /<b>Ищем &lt;React&gt; разработчика<\/b>/);
  assert.match(text, /Опыт &amp; условия/);
  assert.match(text, /Открыть пост в LinkedIn/);
  assert.doesNotMatch(text, /#React/);
});

test('Rate limit pauses the sender before claiming another job', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response('{"ok":false,"parameters":{"retry_after":30}}', {
      status: 429,
    });
  try {
    const sender = new TelegramSender('SECRET', '1');
    assert.equal(sender.isReady(), true);
    await assert.rejects(sender.send('test'));
    assert.equal(sender.isReady(), false);
  } finally {
    globalThis.fetch = original;
  }
});
