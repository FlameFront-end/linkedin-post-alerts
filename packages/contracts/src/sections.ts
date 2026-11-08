export interface VacancySection {
  text: string;
  title?: string;
}
const roleStart =
  /^(?:(?:senior|middle|junior|lead|staff|principal|старший|ведущий|младший)\s+)?(?:front[ -]?end|full[ -]?stack|back[ -]?end|dev[ -]?ops|sre|react|vue|angular|фронт[еэ]нд|фулл?[ -]?ст[еэ]к|б[эе]кенд|девопс)(?=\s|[:—–-]|$)/iu;

/** Split only explicit role headings, preserving shared introduction. */
export function splitVacancies(text: string): VacancySection[] {
  const lines = text
    .replace(
      /([.!?])\s+(?=(?:Frontend|Backend|Full[ -]?stack|DevOps|Фронтенд|Бэкенд|Фуллстек)\s*[:—–-])/giu,
      '$1\n',
    )
    .split('\n');
  const heads = lines.flatMap((line, index) => {
    const clean = line
      .normalize('NFKC')
      .replace(
        /^[\s\p{Extended_Pictographic}\p{Emoji_Presentation}#*\d.)•\-]+/gu,
        '',
      )
      .trim();
    return roleStart.test(clean) &&
      (clean.length < 180 || /^[^:]{1,80}:/.test(clean))
      ? [{ index, title: clean.split(/[:—–]/)[0]!.trim() }]
      : [];
  });
  if (heads.length < 2) return [{ text }];
  const introduction = lines.slice(0, heads[0]!.index).join('\n');
  return heads.map((head, index) => ({
    title: head.title,
    text: [introduction, ...lines.slice(head.index, heads[index + 1]?.index)]
      .filter(Boolean)
      .join('\n'),
  }));
}
