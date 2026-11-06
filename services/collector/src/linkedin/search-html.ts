import { load } from 'cheerio';
import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';
import { LinkedInError } from './errors.js';

export function decodeSearchHtml(
  html: string,
  now = new Date(),
  surface: 'search' | 'feed' = 'search',
): Post[] {
  const $ = load(html);
  const marker = surface === 'feed' ? 'MAIN_FEED_RELEVANCE' : 'FLAGSHIP_SEARCH';
  const cards = $(
    `[role="listitem"][componentkey^="update-card-focus"][componentkey$="FeedType_${marker}"]`,
  );
  if (!cards.length) {
    $('script,style').remove();
    if (
      /Поиск не дал результатов|No results found|No results for/i.test(
        $('body').text(),
      )
    )
      return [];
    throw new LinkedInError('response_format');
  }
  const posts: Post[] = [];
  let recognized = 0;
  cards.each((_, card) => {
    const content = $(card)
      .find('[componentkey^="translatable-commentary"]')
      .first();
    const key = content.attr('componentkey') ?? '';
    const share = key.match(/shareId=(\d{10,25})/)?.[1];
    const ugc = key.match(/ugcPostId=(\d{10,25})/)?.[1];
    const id = share ?? ugc;
    if (!id) return;
    recognized++;
    const commentary = content
      .find('[data-testid="expandable-text-box"]')
      .first();
    commentary.find('br').replaceWith('\n');
    commentary.find('button').remove();
    const text = commentary.text().trim();
    if (!text) return;
    const urn = `urn:li:${share ? 'share' : 'ugcPost'}:${id}`;
    const published = Number(BigInt(id) >> 22n);
    if (published < Date.UTC(2010, 0, 1) || published > now.getTime() + 60000)
      return;
    const author = $(card)
      .find('a[href*="/in/"], a[href*="/company/"]')
      .map((_, a) => $(a).text().trim())
      .get()
      .find(Boolean);
    const post = postSchema.safeParse({
      id: urn,
      url: `https://www.linkedin.com/feed/update/${urn}/`,
      text,
      author: author || 'LinkedIn author',
      publishedAt: new Date(published).toISOString(),
      firstSeenAt: now.toISOString(),
    });
    if (post.success) posts.push(post.data);
  });
  if (!recognized && surface === 'search')
    throw new LinkedInError('response_format');
  return posts;
}
