export type JsonObject = Record<string, unknown>;
export function object(value: unknown): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : {};
}
export function graph(body: unknown) {
  const root = object(body);
  const records = new Map<string, unknown>();
  for (const value of Array.isArray(root.included) ? root.included : []) {
    const node = object(value);
    if (typeof node.entityUrn === 'string') records.set(node.entityUrn, value);
  }
  const resolve = (value: unknown): unknown =>
    typeof value === 'string' && records.has(value)
      ? records.get(value)
      : value;
  function* walk(
    value: unknown = root.data ?? root,
    seen = new Set<unknown>(),
    depth = 0,
  ): Generator<JsonObject> {
    const resolved = resolve(value);
    if (depth > 24 || seen.has(resolved)) return;
    if (typeof resolved === 'object' && resolved !== null) seen.add(resolved);
    if (Array.isArray(resolved)) {
      for (const item of resolved) yield* walk(item, seen, depth + 1);
      return;
    }
    const node = object(resolved);
    if (!Object.keys(node).length) return;
    yield node;
    for (const [key, child] of Object.entries(node))
      if (key !== 'included') yield* walk(child, seen, depth + 1);
  }
  return { root, resolve, walk };
}
export function postUrn(value: unknown): string | undefined {
  if (typeof value !== 'string') return;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    return;
  }
  const urn = decoded.match(/urn:li:(?:activity|ugcPost|share):\d{10,25}/)?.[0];
  if (urn) return urn;
  const slug = decoded.match(
    /-(activity|ugcPost|share)-(\d{10,25})(?:-|$|[/?#])/,
  );
  return slug ? `urn:li:${slug[1]}:${slug[2]}` : undefined;
}
export function encodeValue(value: string) {
  return encodeURIComponent(value).replace(
    /[!'()*]/g,
    (v) => `%${v.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}
// A single LinkedIn post can be addressed by activity, ugcPost and share URNs.
export function urnsOf(value: unknown): string[] {
  const node = object(value);
  const metadata = object(node.metadata);
  const updateMetadata = object(node.updateMetadata);
  const found = new Set<string>();
  for (const candidate of [
    updateMetadata.urn,
    updateMetadata.shareUrn,
    metadata.backendUrn,
    metadata.shareUrn,
    node.urn,
    node.entityUrn,
  ]) {
    const urn = postUrn(candidate);
    if (urn) found.add(urn);
  }
  return [...found];
}
// Activity URN is the stable key for deduplication and the activity-ID timestamp.
export function preferredUrn(urns: string[]): string | undefined {
  return urns.find((urn) => urn.startsWith('urn:li:activity:')) ?? urns[0];
}
