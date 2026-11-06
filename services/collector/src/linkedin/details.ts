import { decodePosts } from './decode.js';
import { graph, object, urnsOf, type JsonObject } from './graph.js';
import { LinkedInError } from './errors.js';
import type { PostReference } from './search.js';

function isUpdate(value: JsonObject) {
  return (
    urnsOf(value).length > 0 &&
    Boolean(
      value.updateMetadata ||
      object(value.metadata).backendUrn ||
      value.commentary ||
      value.resharedUpdate ||
      value['*resharedUpdate'] ||
      String(value.$type).endsWith('UpdateV2') ||
      String(value.$type).endsWith('.Update'),
    )
  );
}

export function decodeDetails(body: unknown, reference: PostReference) {
  const view = graph(body);
  const updates = [...view.walk()].filter(isUpdate);
  // A post has several URNs (activity/ugcPost/share): match by any of them.
  let node = updates.find((value) => urnsOf(value).includes(reference.urn));
  if (!node) {
    // Fall back only when the response unambiguously contains one top-level post.
    const nested = new Set<unknown>(
      updates.map((value) =>
        view.resolve(value.resharedUpdate ?? value['*resharedUpdate']),
      ),
    );
    const top = updates.filter((value) => !nested.has(value));
    if (top.length === 1) node = top[0];
  }
  if (!node) throw new LinkedInError('response_format', 60, 'detail_format');
  // Reuse author-feed parsing for the complete update. Preserve normalized refs.
  const result = decodePosts({
    data: { elements: [node], paging: { start: 0, total: 1 } },
    included: view.root.included,
  });
  return result.posts[0]; // media-only posts intentionally produce no text notification
}
