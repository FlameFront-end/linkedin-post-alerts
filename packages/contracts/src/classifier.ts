import type { Role } from './index.js';

export interface Classification {
  roles: Role[];
  russian: boolean;
  reason: 'matched' | 'closed' | 'candidate' | 'no_hiring' | 'no_role';
}
export function classify(text: string): Classification {
  const normalized = text.normalize('NFKC').toLowerCase();
  const russianWords = normalized.match(/[а-яё]{2,}/g)?.length ?? 0;
  const latinWords = normalized.match(/[a-z]{2,}/g)?.length ?? 0;
  const russian = russianWords >= 3 && russianWords >= latinWords;
  const result = (
    reason: Classification['reason'],
    roles: Role[] = [],
  ): Classification => ({ roles, russian, reason });
  if (
    /ваканси[яи]\s+закрыт|позици[яи]\s+закрыт|position\s+(?:is\s+)?closed|no longer hiring/iu.test(
      normalized,
    )
  )
    return result('closed');
  if (
    /ищу\s+(?:работу|ваканси|новую\s+работу)|в\s+поиске\s+работы|looking for (?:a |my next )?(?:job|role|opportunity)|open to work/iu.test(
      normalized,
    )
  )
    return result('candidate');
  if (
    !/ищем|ваканси|ищу\s+(?:frontend|full[ -]?stack|фронт|фуллстек)|нанимаем|открыта\s+позиция|в\s+поиске\s+.{0,30}(?:разработчика|инженера)|hiring|we(?:'re| are) looking|join our team/iu.test(
      normalized,
    )
  )
    return result('no_hiring');
  const roles: Role[] = [];
  const fullstack = /\bfull[ -]?stack\b|фулл[ -]?ст[еэ]к/u.test(normalized);
  if (fullstack) roles.push('fullstack');
  if (/\bfront[ -]?end\b|фронт[еэ]нд/iu.test(normalized))
    roles.push('frontend');
  else if (
    !fullstack &&
    !/\b(?:dev[ -]?ops|sre|backend|back-end)\b|девопс|б[эе]кенд/u.test(
      normalized,
    ) &&
    /\b(?:react|vue|angular|next\.js|nuxt|svelte|ui)\s*(?:[- ]\s*)?(?:developer|engineer|разработчик|инженер)|(?:разработчик|инженер)\w*\s+(?:react|vue|angular|next\.js|nuxt|svelte)/iu.test(
      normalized,
    )
  )
    roles.push('frontend');
  if (/\bdev[ -]?ops\b|\bsre\b|site reliability|девопс/iu.test(normalized))
    roles.push('devops');
  return roles.length ? result('matched', roles) : result('no_role');
}

export function vacancyRoles(decision: Classification): Role[] {
  return decision.russian
    ? decision.roles.filter((role) => role !== 'devops')
    : [];
}
