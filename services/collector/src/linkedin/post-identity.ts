/** Both observed LinkedIn commentary key variants identify the same post types. */
export function commentaryUrn(key: string): string | undefined {
  const share = key.match(/shareId=(\d{10,25})/)?.[1];
  const ugc = key.match(
    /(?:ugcPostId|userGeneratedContentId)=(\d{10,25})/,
  )?.[1];
  return share
    ? `urn:li:share:${share}`
    : ugc
      ? `urn:li:ugcPost:${ugc}`
      : undefined;
}
export function publishedFromUrn(urn: string, now: Date): string | undefined {
  const id = urn.match(/:(\d+)$/)?.[1];
  if (!id) return;
  const published = Number(BigInt(id) >> 22n);
  if (published < Date.UTC(2010, 0, 1) || published > now.getTime() + 60000)
    return;
  return new Date(published).toISOString();
}
