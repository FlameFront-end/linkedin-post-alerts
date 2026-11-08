export function vacancyImageUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'media.licdn.com' &&
      !url.username &&
      !url.password &&
      !url.hash &&
      /\/dms\/image\//.test(url.pathname) &&
      /feedshare|article-cover|image-shrink/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
