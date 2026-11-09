import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  RotatingLogFile,
  sanitize,
  errorFields,
  withLogContext,
  log,
} from '../packages/runtime/src/logger.js';
test('Structured logs redact credentials, raw provider content, URLs and personal contacts', () => {
  const value = sanitize({
    cookie: 'SESSION_SECRET',
    telegramToken: 'TOKEN_SECRET',
    payload: 'FULL_POST',
    headers: 'HEADERS',
    text: 'PRIVATE',
    message: 'URL_WITH_SECRET',
    endpoint: 'feed',
    postId: 'urn:li:share:123',
    detail: 'https://example.com/?secret=value user@example.com',
  });
  const serialized = JSON.stringify(value);
  for (const secret of [
    'SESSION_SECRET',
    'TOKEN_SECRET',
    'FULL_POST',
    'HEADERS',
    'PRIVATE',
    'URL_WITH_SECRET',
    'secret=value',
    'user@example.com',
  ])
    assert.ok(!serialized.includes(secret));
  assert.equal(value.endpoint, 'feed');
  assert.equal(value.postId, 'urn:li:share:123');
});
test('Errors retain machine code without stack, message or arbitrary provider content', () => {
  const error = Object.assign(
    new Error('https://api.telegram.org/botSECRET/sendMessage'),
    { code: 'ECONNRESET', reason: 'upstream_timeout' },
  );
  assert.deepEqual(errorFields(error), {
    errorType: 'Error',
    errorCode: 'ECONNRESET',
    reason: 'upstream_timeout',
  });
  assert.ok(!JSON.stringify(errorFields(error)).includes('SECRET'));
});
test('File logs rotate by size, remove expired days and use private permissions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alerts-log-test-'));
  try {
    const writer = new RotatingLogFile(directory, 'collector', 30, 2, 2);
    writer.write('old', new Date('2026-11-01T10:00:00Z'));
    for (let i = 0; i < 6; i++)
      writer.write(
        JSON.stringify({ record: i }),
        new Date('2026-11-09T10:00:00Z'),
      );
    const names = await readdir(directory);
    assert.ok(!names.some((name) => name.includes('11-01')));
    assert.equal(names.length, 3);
    assert.ok(
      (
        await readFile(join(directory, 'collector-2026-11-09.jsonl'), 'utf8')
      ).includes('5'),
    );
    assert.equal(
      (await stat(join(directory, 'collector-2026-11-09.jsonl'))).mode & 0o777,
      0o600,
    );
    assert.throws(() => new RotatingLogFile(directory, '../escape'));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
test('Concurrent traces stay isolated and persist as valid JSON lines', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alerts-context-test-'));
  const before = process.env.LOG_DIR;
  process.env.LOG_DIR = directory;
  try {
    await Promise.all(
      ['one', 'two'].map((traceId) =>
        withLogContext({ traceId }, async () => {
          await new Promise((resolve) => setTimeout(resolve, 2));
          log('test-context', 'check', { marker: traceId, token: 'SECRET' });
        }),
      ),
    );
    const names = await readdir(directory);
    const records = (await readFile(join(directory, names[0]!), 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    assert.equal(records.length, 2);
    assert.ok(
      records.every(
        (record) =>
          record.traceId === record.marker && record.token === '[REDACTED]',
      ),
    );
  } finally {
    if (before === undefined) delete process.env.LOG_DIR;
    else process.env.LOG_DIR = before;
    await rm(directory, { recursive: true, force: true });
  }
});
