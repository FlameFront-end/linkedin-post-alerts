import { graph, object, postUrn } from './graph.js';
import { LinkedInError } from './errors.js';
export interface PostReference {
  urn: string;
  url: string;
  slug?: string;
}
export interface SearchPage {
  references: PostReference[];
  total?: number;
  nextStart?: number;
  empty: boolean;
}

// Search summaries are discovery data, NEVER the full text of the vacancy.
export function decodeSearch(body: unknown): SearchPage {
  const view = graph(body);
  const nodes = [...view.walk()];
  const collections = nodes.filter(
    (node) =>
      (Array.isArray(node.elements) || Array.isArray(node['*elements'])) &&
      typeof object(node.paging).start === 'number',
  );
  const collection = collections[0];
  if (!collection) throw new LinkedInError('response_format');
  const paging = object(collection.paging);
  const elements = (collection.elements ??
    collection['*elements']) as unknown[];
  const references = new Map<string, PostReference>();
  for (const node of nodes) {
    if (!String(node.$type).endsWith('EntityResultViewModel')) continue;
    const rawUrl =
      typeof node.navigationUrl === 'string' ? node.navigationUrl : undefined;
    let url: URL | undefined;
    try {
      if (rawUrl) url = new URL(rawUrl);
    } catch {
      /* malformed card */
    }
    if (
      url &&
      (url.protocol !== 'https:' ||
        !['www.linkedin.com', 'linkedin.com'].includes(url.hostname))
    )
      continue;
    const urn = postUrn(url?.pathname) ?? postUrn(node.entityUrn);
    if (!urn) continue;
    const slug = url?.pathname.match(/^\/posts\/([^/]+)\/?$/)?.[1];
    references.set(urn, {
      urn,
      url: `https://www.linkedin.com/feed/update/${urn}/`,
      ...(slug ? { slug } : {}),
    });
  }
  if (elements.length && !references.size)
    throw new LinkedInError('response_format');
  if (
    !elements.length &&
    typeof paging.total === 'number' &&
    paging.total > Number(paging.start)
  )
    throw new LinkedInError('response_format');
  const nextStart =
    typeof paging.count === 'number' && paging.count > 0
      ? Number(paging.start) + paging.count
      : undefined;
  return {
    references: [...references.values()],
    empty: !elements.length,
    ...(typeof paging.total === 'number' ? { total: paging.total } : {}),
    ...(nextStart !== undefined ? { nextStart } : {}),
  };
}
