import { decodePosts } from './decode.js';
import { graph, object, postUrn } from './graph.js';
import { LinkedInError } from './errors.js';
import type { PostReference } from './search.js';

export function decodeDetails(body: unknown, reference: PostReference) {
  const view = graph(body);
  const node = [...view.walk()].find((value) => {
    const id = postUrn(
      object(value.updateMetadata).urn ??
        object(value.metadata).backendUrn ??
        value.urn ??
        value.entityUrn,
    );
    return (
      id === reference.urn &&
      (value.commentary ||
        value.content ||
        value.resharedUpdate ||
        value['*resharedUpdate'] ||
        String(value.$type).endsWith('UpdateV2') ||
        String(value.$type).endsWith('.Update'))
    );
  });
  if (!node) throw new LinkedInError('response_format');
  // Reuse author-feed parsing for the complete update. Preserve normalized refs.
  const result = decodePosts({
    data: { elements: [node], paging: { start: 0, total: 1 } },
    included: view.root.included,
  });
  return result.posts[0]; // media-only posts intentionally produce no text notification
}
