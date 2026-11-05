import {
  postSchema,
  type Post,
} from '../../../../packages/contracts/src/index.js';
import { LinkedInError } from './errors.js';
type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as ObjectValue)
    : {};
}
function text(value: unknown): string {
  return typeof value === 'string'
    ? value
    : typeof object(value).text === 'string'
      ? (object(value).text as string)
      : '';
}

// Follow only records reachable from the collection, not unrelated included[] entries.
export function decodePosts(
  body: unknown,
  now = new Date(),
): {
  posts: Post[];
  count: number;
  total?: number;
  paginationToken?: string;
  skippedNoText: number;
} {
  const root = object(body);
  const records = new Map<string, unknown>();
  if (Array.isArray(root.included))
    for (const value of root.included) {
      const entry = object(value);
      if (typeof entry.entityUrn === 'string')
        records.set(entry.entityUrn, value);
    }
  let collection: ObjectValue | undefined;
  const sought = new Set<string>();
  const seek = (value: unknown, depth = 0): void => {
    if (collection || depth > 12) return;
    if (typeof value === 'string' && records.has(value)) {
      if (sought.has(value)) return;
      sought.add(value);
      seek(records.get(value), depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) seek(item, depth + 1);
      return;
    }
    const node = object(value);
    if (
      (Array.isArray(node.elements) || Array.isArray(node['*elements'])) &&
      typeof object(node.paging).start === 'number'
    ) {
      collection = node;
      return;
    }
    for (const [key, child] of Object.entries(node))
      if (key !== 'included') seek(child, depth + 1);
  };
  seek(root);
  if (!collection) throw new LinkedInError('response_format');
  const current = collection as ObjectValue;
  const elements = (current.elements ?? current['*elements']) as unknown[];
  const paging = object(current.paging);
  if (
    !elements.length &&
    typeof paging.total === 'number' &&
    typeof paging.start === 'number' &&
    paging.total > paging.start
  )
    throw new LinkedInError('response_format');
  const posts = new Map<string, Post>();
  let candidates = 0;
  let skippedNoText = 0;
  const resolveNode = (value: unknown) =>
    object(typeof value === 'string' ? records.get(value) : value);
  const contentOf = (node: ObjectValue, depth = 0): string => {
    if (depth > 4) return '';
    const own = text(object(node.commentary).text);
    const reshared = resolveNode(
      node.resharedUpdate ?? node['*resharedUpdate'],
    );
    const original = Object.keys(reshared).length
      ? contentOf(reshared, depth + 1)
      : '';
    return [own, original].filter(Boolean).join('\n\n');
  };
  const walk = (
    value: unknown,
    visited = new Set<string>(),
    depth = 0,
  ): void => {
    if (depth > 16) return;
    if (typeof value === 'string' && records.has(value)) {
      if (visited.has(value)) return;
      visited.add(value);
      walk(records.get(value), visited, depth + 1);
      return;
    }
    if (Array.isArray(value)) {
      for (const child of value) walk(child, visited, depth + 1);
      return;
    }
    const node = object(value);
    const metadata = object(node.updateMetadata);
    const urnValue = metadata.urn ?? node.urn ?? node.entityUrn;
    const urn =
      typeof urnValue === 'string'
        ? urnValue.match(/urn:li:activity:(\d+)/)?.[0]
        : undefined;
    const content = contentOf(node);
    if (
      urn &&
      (node.updateMetadata ||
        node.commentary ||
        node.resharedUpdate ||
        node['*resharedUpdate'] ||
        String(node.$type).endsWith('UpdateV2'))
    ) {
      candidates++;
      if (!content.trim()) {
        skippedNoText++;
        return;
      }
      const actor = object(node.actor ?? records.get(String(node['*actor'])));
      const published =
        typeof node.createdAt === 'number'
          ? node.createdAt
          : Number(BigInt(urn.split(':').at(-1)!) >> 22n);
      if (
        !Number.isFinite(published) ||
        published < Date.UTC(2010, 0, 1) ||
        published > now.getTime() + 86400000
      )
        throw new LinkedInError('response_format');
      const parsed = postSchema.safeParse({
        id: urn,
        url: `https://www.linkedin.com/feed/update/${urn}/`,
        text: content,
        author: text(actor.name) || 'LinkedIn author',
        publishedAt: new Date(published).toISOString(),
        firstSeenAt: now.toISOString(),
      });
      if (!parsed.success) throw new LinkedInError('response_format');
      posts.set(urn, parsed.data);
      return; // Do not turn a nested old repost into a separate freshly discovered item.
    }
    for (const [key, child] of Object.entries(node))
      if (key !== 'included' && key !== 'paging')
        walk(child, visited, depth + 1);
  };
  for (const element of elements) walk(element);
  if (elements.length && !candidates)
    throw new LinkedInError('response_format');
  return {
    posts: [...posts.values()],
    count: elements.length,
    skippedNoText,
    ...(typeof object(current.metadata).paginationToken === 'string'
      ? { paginationToken: object(current.metadata).paginationToken as string }
      : {}),
    ...(typeof paging.total === 'number' ? { total: paging.total } : {}),
  };
}
