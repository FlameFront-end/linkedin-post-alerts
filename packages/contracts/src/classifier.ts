import type { Post, Role } from './index.js';

export type LanguageMatch = 'russian' | 'required' | 'none';
export interface Classification {
  roles: Role[];
  russian: boolean;
  language: LanguageMatch;
  reason: 'matched' | 'closed' | 'candidate' | 'no_hiring' | 'no_role';
}

export function languageMatch(text: string): LanguageMatch {
  const normalized = text.normalize('NFKC').toLowerCase();
  const russianWords = normalized.match(/[а-яё]{2,}/g)?.length ?? 0;
  const latinWords = normalized.match(/[a-z]{2,}/g)?.length ?? 0;
  const russianContext =
    normalized.match(
      /(?<![а-яё])(?:ищем|требуется|работа|обязанности|условия|команд[аеуы]|нужно|опыт|навыки|работать|удал[её]нно|знание|будет|предлагаем|должен)(?![а-яё])/gu,
    )?.length ?? 0;
  if (
    russianWords >= 3 &&
    (russianWords >= latinWords || (russianWords >= 8 && russianContext >= 2))
  )
    return 'russian';

  for (const clause of normalized.split(
    /[\n.!?;]+|,\s*(?=(?:english|russian)\b)/,
  )) {
    if (
      /русск(?:ий|ого|им|ом|ому)|русскоязычн/u.test(clause) &&
      !/не\s+обязат|желательн|будет\s+плюсом/u.test(clause) &&
      /обязател|свободн|родно|носител/u.test(clause)
    )
      return 'required';
    if (!/\brussian\b/.test(clause)) continue;
    // Preferences and alternatives do not make Russian mandatory.
    if (
      /\b(?:optional|preferred|advantage|bonus|plus|desirable|beneficial)\b|nice[- ]to[- ]have|would be nice|not\s+(?:a\s+)?(?:requirement|must|essential)|not\s+(?:strictly\s+)?(?:required|necessary|mandatory)|no\s+russian|russian\s+(?:or|and\/or)\s+\w+|\w+\s+or\s+russian/.test(
        clause,
      )
    )
      continue;
    if (
      /\brussian\b.{0,80}\b(?:required|mandatory|essential|must|fluent|native|proficien\w*|[bc][12])\b|\b(?:require\w*|mandatory|must|fluent|native|fluency|proficien\w*)\b.{0,60}\brussian\b|\brussian[- ]speaking\s+(?:front\w*|full\w*|react|vue|angular|javascript|typescript|software|web|developer|engineer)/.test(
        clause,
      )
    )
      return 'required';
  }
  return 'none';
}

function detectRoles(text: string): Role[] {
  const roles: Role[] = [];
  const fullstack = /\bfull[ -]?stack\b|фулл?[ -]?ст[еэ]к/u.test(text);
  const infrastructure =
    /\b(?:dev[ -]?ops|sre)\b|site reliability|девопс/u.test(text);
  const backend = /\bback[ -]?end\b|б[эе]кенд/u.test(text);
  if (fullstack) roles.push('fullstack');
  if (/\bfront[ -]?end\b|фронт[еэ]нд/u.test(text)) roles.push('frontend');
  else if (
    !infrastructure &&
    !backend &&
    !fullstack &&
    /(?:\b(?:react(?:\.js)?|vue(?:\.js)?|angular|next\.js|nuxt|svelte|ui|web|javascript|typescript)\s*[- /]?\s*(?:developer|engineer|разработчик|инженер)|(?:разработчик|инженер)[а-яё]*\s+(?:react|vue|angular|next\.js|nuxt|svelte|javascript|typescript)|веб[ -]?разработчик)/u.test(
      text,
    )
  )
    roles.push('frontend');
  if (infrastructure) roles.push('devops');
  return roles;
}

export function classify(
  text: string,
  context: { title?: string | undefined; listing?: boolean } = {},
): Classification {
  const normalized = text.normalize('NFKC').toLowerCase();
  const title = context.title?.normalize('NFKC').toLowerCase();
  const language = languageMatch(
    [title, normalized].filter(Boolean).join('\n'),
  );
  const result = (
    reason: Classification['reason'],
    roles: Role[] = [],
  ): Classification => ({
    roles,
    russian: language === 'russian',
    language,
    reason,
  });
  if (
    /ваканси[яи]\s+закрыт|позици[яи]\s+закрыт|position\s+(?:is\s+)?closed|no longer hiring|no longer accepting applications/u.test(
      normalized,
    )
  )
    return result('closed');
  const candidate =
    /(?:^|[\n.!?])\s*(?:я\s+[^.!?\n]{0,70})?(?:ищу\s+(?:работу|ваканси|новую\s+работу)|в\s+поиске\s+работы)|\b(?:i am|i'm|i’m)\s+(?:actively\s+)?looking for (?:a |my next )?(?:job|role|opportunity)/u.test(
      normalized,
    );
  const hiring =
    context.listing ||
    /ищем|ваканси|ищу\s+(?:frontend|full[ -]?stack|фронт|фулл?стек|react|vue|angular)|нанимаем|открыта\s+позиция|в\s+поиске\s+.{0,30}(?:разработчика|инженера)|\bhiring\b|we(?:'re| are|’re) looking|join our team/u.test(
      normalized,
    );
  if (
    candidate ||
    (!hiring &&
      /open to work|ищу работу|looking for (?:a )?(?:job|role|opportunity)/u.test(
        normalized,
      ))
  )
    return result('candidate');
  if (!hiring) return result('no_hiring');
  const roles = detectRoles(title ?? normalized);
  return roles.length ? result('matched', roles) : result('no_role');
}

export function classifyPost(post: Post): Classification {
  return classify(post.text, {
    title: post.title,
    listing: post.kind === 'job',
  });
}
export function vacancyRoles(decision: Classification): Role[] {
  return decision.language !== 'none'
    ? decision.roles.filter((role) => role !== 'devops')
    : [];
}
