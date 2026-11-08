export type LanguageMatch = 'russian' | 'required' | 'none';
export interface LanguageAssessment {
  language: LanguageMatch;
  evidence?: string;
}

/** Language requirements are evaluated within a clause, including negation. */
export function assessLanguage(text: string): LanguageAssessment {
  const normalized = text.normalize('NFKC').toLowerCase();
  const words =
    normalized.match(/(?<!\p{L})[а-яё]{2,}(?!\p{L})/gu)?.length ?? 0;
  const latin = normalized.match(/[a-z]{2,}/g)?.length ?? 0;
  const context =
    normalized.match(
      /(?<![а-яё])(?:ищем|требуется|работа|обязанности|условия|команд[аеуы]|нужно|опыт|навыки|работать|удал[её]нно|знание|будет|предлагаем|должен)(?![а-яё])/gu,
    )?.length ?? 0;
  const otherCyrillic = normalized.match(/[іїєґў]/gu)?.length ?? 0;
  if (
    words >= 3 &&
    context >= 1 &&
    otherCyrillic < 3 &&
    (words >= latin || (words >= 8 && context >= 2))
  ) {
    return { language: 'russian' };
  }
  const clauses = text
    .normalize('NFKC')
    .split(
      /[\n.!?;]+|,\s*(?=(?:english|russian|german|french|spanish|polish|ukrainian|английский|русский)(?=\W|$))/i,
    );
  for (const original of clauses) {
    const clause = original.toLowerCase().replace(/[’‘]/g, "'");
    if (!/\brussian\b|русск(?:ий|ого|им|ом|ому)|русскоязычн/u.test(clause))
      continue;
    if (
      /russian(?:[- ]speaking)?\s+(?:company|office|market|team|community)\b/.test(
        clause,
      ) &&
      !/fluent|fluency|proficien|language|speak\s+russian/.test(clause)
    )
      continue;
    const negative =
      /\b(?:not|never)\s+(?:strictly\s+)?(?:required|necessary|mandatory|essential)|\bnot\s+(?:a\s+)?(?:requirement|must)|\b(?:do(?:es)?\s+not|don'?t|doesn'?t|no\s+need\s+to)\s+(?:\w+\s+){0,6}(?:require|need|speak|know)|\bwithout\s+(?:\w+\s+){0,3}russian|\bno\s+russian|\b(?:optional|preferred|advantage|bonus|plus|desirable|beneficial)\b|nice[- ]to[- ]have|would be nice|russian\s+(?:or|and\/or)\s+\w+|\w+\s+or\s+russian|не\s+(?:обязател|требует|нуж)|желательн|будет\s+плюсом/u;
    if (negative.test(clause)) continue;
    if (
      /\brussian[- ]speaking\b|\brussian\b.{0,80}\b(?:required|mandatory|essential|must|fluent|native|proficien\w*|[bc][12])\b|\b(?:require\w*|mandatory|must|fluent|native|fluency|proficien\w*)\b.{0,60}\brussian\b|русск[^.!?\n]{0,45}(?:обязател|свободн|родно|носител)|(?:обязател|свободн|родно|носител)[^.!?\n]{0,45}русск/u.test(
        clause,
      )
    ) {
      return { language: 'required', evidence: original.trim().slice(0, 240) };
    }
  }
  return { language: 'none' };
}
export function languageMatch(text: string): LanguageMatch {
  return assessLanguage(text).language;
}
