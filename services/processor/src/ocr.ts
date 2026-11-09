import { log } from '../../../packages/runtime/src/logger.js';
import type { Post } from '../../../packages/contracts/src/index.js';
/** OCR is isolated from the collector; it has no LinkedIn cookies or Telegram token. */
export async function enrichImages(
  post: Post,
  endpoint = process.env.OCR_URL,
  request: typeof fetch = fetch,
): Promise<Post> {
  if (
    !endpoint ||
    !post.imageUrls?.length ||
    post.ocrApplied ||
    post.text.length > 2000
  )
    return post;
  log('processor', 'ocr_started', {
    postId: post.id,
    images: post.imageUrls.length,
  });
  const texts: string[] = [];
  for (const url of post.imageUrls) {
    const response = await request(new URL('/extract', endpoint), {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
      signal: AbortSignal.timeout(40000),
    });
    log('processor', 'ocr_response', {
      postId: post.id,
      httpStatus: response.status,
    });
    if (!response.ok) throw Error('OCR unavailable');
    const body: unknown = await response.json();
    if (
      !body ||
      typeof body !== 'object' ||
      !('text' in body) ||
      typeof body.text !== 'string' ||
      body.text.length > 60000
    )
      throw Error('Invalid OCR response');
    if (body.text.trim()) texts.push(body.text.trim());
  }
  log('processor', 'ocr_completed', {
    postId: post.id,
    segments: texts.length,
    chars: texts.reduce((n, text) => n + text.length, 0),
  });
  return {
    ...post,
    text: [
      post.text === '[Текст вакансии на изображении]' && texts.length
        ? ''
        : post.text,
      ...texts,
    ]
      .filter(Boolean)
      .join('\n\n')
      .slice(0, 100000),
    ocrApplied: true,
  };
}
