import type { Role } from '../../../packages/contracts/src/index.js';

export interface Classification {
  roles: Role[];
  russian: boolean;
  reason: 'matched' | 'closed' | 'candidate' | 'no_hiring' | 'no_role';
}
export function classify(text: string): Classification {
  const normalized = text.normalize('NFKC').toLowerCase();
  const russian = /[а-яё]/i.test(normalized);
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
    !/ищем|ваканси|нанимаем|открыта\s+позиция|в\s+поиске\s+.{0,30}(?:разработчика|инженера)|hiring|we(?:'re| are) looking|join our team/iu.test(
      normalized,
    )
  )
    return result('no_hiring');
  const roles: Role[] = [];
  if (
    /\bfront[ -]?end\b|фронт[еэ]нд|\breact(?:\.js|js)?\b|\bvue(?:\.js|js)?\b|\bangular\b/iu.test(
      normalized,
    )
  )
    roles.push('frontend');
  if (/\bdev[ -]?ops\b|\bsre\b|site reliability|девопс/iu.test(normalized))
    roles.push('devops');
  return roles.length ? result('matched', roles) : result('no_role');
}
