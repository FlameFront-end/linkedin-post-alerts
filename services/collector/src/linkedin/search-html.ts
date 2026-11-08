import { load } from 'cheerio';
import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';
import { LinkedInError } from './errors.js';
export interface HtmlPage {
  posts: Post[];
  cards: number;
  skippedNoText: number;
}
export function decodeHtmlPage(
  html: string,
  now = new Date(),
  surface: 'search' | 'feed' = 'search',
): HtmlPage {
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
      return { posts: [], cards: 0, skippedNoText: 0 };
    throw new LinkedInError('response_format');
  }
  const posts: Post[] = [];
  let recognized = 0,
    skippedNoText = 0;
  cards.each((_, card) => {
    const contents = $(card).find('[componentkey^="translatable-commentary"]');
    const firstKey = contents.first().attr('componentkey') ?? '';
    const share = firstKey.match(/shareId=(\d{10,25})/)?.[1];
    const ugc = firstKey.match(/ugcPostId=(\d{10,25})/)?.[1];
    const id = share ?? ugc;
    if (!id) {
      skippedNoText++;
      return;
    }
    recognized++;
    const texts = new Set<string>();
    let incomplete = false;
    contents.each((_, content) => {
      const commentary = $(content)
        .find('[data-testid="expandable-text-box"]')
        .first();
      if (
        commentary.find('button[aria-expanded="false"]').length ||
        /(?:…|\.\.\.)\s*(?:ещ[её]|see more)?$/i.test(commentary.text().trim())
      )
        incomplete = true;
      commentary.find('br').replaceWith('\n');
      commentary.find('button').remove();
      const text = commentary.text().trim();
      if (text) texts.add(text);
    });
    const text = [...texts].join('\n\n');
    if (!text) {
      skippedNoText++;
      return;
    }
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
      ...(incomplete ? { textIncomplete: true } : {}),
    });
    if (post.success) posts.push(post.data);
  });
  if (!recognized)
    throw new LinkedInError('response_format', 60, 'html_unrecognized_cards');
  return { posts, cards: cards.length, skippedNoText };
}
export function decodeSearchHtml(
  html: string,
  now = new Date(),
  surface: 'search' | 'feed' = 'search',
): Post[] {
  return decodeHtmlPage(html, now, surface).posts;
}
