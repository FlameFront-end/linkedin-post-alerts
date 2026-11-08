import express from 'express';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { vacancyImageUrl } from '../../../packages/contracts/src/media.js';
const execute = promisify(execFile);
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '8kb' }));
let busy = false;
const cache = new Map<string, { text: string; until: number }>();
app.get('/health/live', (_req, res) => res.json({ status: 'alive' }));
app.get('/health/ready', async (_req, res) => {
  try {
    await execute('tesseract', ['--version'], { timeout: 2000 });
    res.json({ status: 'ready' });
  } catch {
    res.status(503).json({ status: 'unavailable' });
  }
});
app.post('/extract', async (req, res) => {
  const url: unknown = req.body?.url;
  if (typeof url !== 'string' || !vacancyImageUrl(url)) {
    res.status(400).json({ code: 'invalid_image_url' });
    return;
  }
  const key = new URL(url).origin + new URL(url).pathname;
  const cached = cache.get(key);
  if (cached && cached.until > Date.now()) {
    res.json({ text: cached.text });
    return;
  }
  if (busy) {
    res.status(429).set('Retry-After', '30').json({ code: 'busy' });
    return;
  }
  busy = true;
  let directory: string | undefined;
  try {
    const response = await fetch(url, {
      redirect: 'manual',
      signal: AbortSignal.timeout(10000),
    });
    if (
      !response.ok ||
      !response.headers.get('content-type')?.startsWith('image/')
    )
      throw Error('image_unavailable');
    const reader = response.body?.getReader();
    if (!reader) throw Error('empty_image');
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      while (true) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.length;
        if (size > 5 * 1024 * 1024) {
          await reader.cancel();
          throw Error('image_too_large');
        }
        chunks.push(part.value);
      }
    } finally {
      reader.releaseLock();
    }
    directory = await mkdtemp(join(tmpdir(), 'vacancy-ocr-'));
    const file = join(directory, 'image');
    await writeFile(file, Buffer.concat(chunks), { mode: 0o600 });
    const result = await execute(
      'tesseract',
      [file, 'stdout', '-l', 'rus+eng', '--psm', '11'],
      { timeout: 25000, maxBuffer: 512 * 1024 },
    );
    const text = result.stdout.normalize('NFKC').trim().slice(0, 60000);
    cache.set(key, { text, until: Date.now() + 3600000 });
    while (cache.size > 200) cache.delete(cache.keys().next().value!);
    res.json({ text });
  } catch {
    res.status(503).json({ code: 'ocr_unavailable' });
  } finally {
    busy = false;
    if (directory)
      await rm(directory, { recursive: true, force: true }).catch(
        () => undefined,
      );
  }
});
const server = app.listen(3104, '0.0.0.0');
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => server.close());
