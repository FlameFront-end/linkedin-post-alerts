export interface VacancySection {
  text: string;
  title?: string;
}
const roleStart =
  /^(?:(?:senior|middle|junior|lead|staff|principal|старший|ведущий|младший)\s+)?(?:front[ -]?end|full[ -]?stack|back[ -]?end|dev[ -]?ops|sre|react|vue|angular|фронт[еэ]нд|фулл?[ -]?ст[еэ]к|б[эе]кенд|девопс)(?=\s|[:—–-]|$)/iu;

export function vacancyRowTitle(line: string): string | undefined {
  const prefix =
    /^\s*(?:\p{Regional_Indicator}{2}\s*)?(?:[•▪◦●🔹🔸]\s*|[-*]\s+|\d+[.)]\s+)/u.exec(
      line,
    );
  if (!prefix || !/\s\|\s/.test(line)) return undefined;
  return (
    line
      .slice(prefix[0].length)
      .split(/\s\|\s/, 1)[0]!
      .trim() || undefined
  );
}

/** Split explicit vacancy rows and role headings. */
export function splitVacancies(text: string): VacancySection[] {
  const lines = text
    .replace(
      /([.!?])\s+(?=(?:Frontend|Backend|Full[ -]?stack|DevOps|Фронтенд|Бэкенд|Фуллстек)\s*[:—–-])/giu,
      '$1\n',
    )
    .split('\n');
  // Numbered/bulleted job-board entries may mix occupations and languages.
  // Treat every row as a boundary, even when the title is outside our profile.
  const rows = lines.flatMap((line, index) => {
    const title = vacancyRowTitle(line);
    return title ? [{ index, title }] : [];
  });
  if (rows.length >= 2) {
    return rows.map((row, index) => ({
      title: row.title,
      text: lines.slice(row.index, rows[index + 1]?.index).join('\n'),
    }));
  }
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
