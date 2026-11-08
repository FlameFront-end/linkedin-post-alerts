import type { Post, Role } from './index.js';
import { assessLanguage, type LanguageMatch } from './language.js';
import { splitVacancies } from './sections.js';
export { languageMatch } from './language.js';
export type { LanguageMatch } from './language.js';
export interface Classification {
  roles: Role[];
  russian: boolean;
  language: LanguageMatch;
  evidence?: string;
  reason:
    | 'matched'
    | 'closed'
    | 'candidate'
    | 'promotion'
    | 'no_hiring'
    | 'no_role'
    | 'no_language';
}
const frontend = /\bfront[ -]?end\b|фронт[еэ]нд/u;
const fullstack = /\bfull[ -]?stack\b|фулл?[ -]?ст[еэ]к/u;
const backend = /\bback[ -]?end\b|б[эе]кенд/u;
const infrastructure = /\b(?:dev[ -]?ops|sre)\b|site reliability|девопс/u;
const adjacent =
  /(?:\b(?:react(?:\.js)?|vue(?:\.js)?|angular|next\.js|nuxt|svelte|ui|web|javascript|typescript)\s*[- /]?\s*(?:developer|engineer|разработчик|инженер)|(?:разработчик|инженер)[а-яё]*\s+(?:react|vue|angular|next\.js|nuxt|svelte|javascript|typescript)|веб[ -]?разработчик)/u;

function detectRoles(text: string): Role[] {
  const roles: Role[] = [];
  if (fullstack.test(text)) roles.push('fullstack');
  if (frontend.test(text)) roles.push('frontend');
  else if (
    !infrastructure.test(text) &&
    !backend.test(text) &&
    !fullstack.test(text) &&
    adjacent.test(text)
  )
    roles.push('frontend');
  if (infrastructure.test(text)) roles.push('devops');
  return roles;
}
export function plausibleJobTitle(title: string): boolean {
  const value = title.normalize('NFKC').toLowerCase();
  if (detectRoles(value).some((role) => role !== 'devops')) return true;
  return (
    !backend.test(value) &&
    !infrastructure.test(value) &&
    /software|разработчик|программист|инженер|application|product engineer/u.test(
      value,
    )
  );
}
function classifySection(
  text: string,
  context: { title?: string | undefined; listing?: boolean },
): Classification {
  const value = text.normalize('NFKC').toLowerCase();
  const title = context.title?.normalize('NFKC').toLowerCase();
  const language = assessLanguage([title, text].filter(Boolean).join('\n'));
  const result = (
    reason: Classification['reason'],
    roles: Role[] = [],
  ): Classification => ({
    roles,
    russian: language.language === 'russian',
    ...language,
    reason,
  });
  if (
    /ваканси[яи]\s+закрыт|позици[яи]\s+закрыт|position\s+(?:is\s+)?closed|no longer hiring|no longer accepting applications/u.test(
      value,
    )
  )
    return result('closed');
  if (
    /(?:я\s+[^.!?\n]{0,70})?(?:ищу\s+(?:работу|новую\s+работу)|рассматриваю\s+(?:новые\s+)?(?:вакансии|предложения)|в\s+поиске\s+работы)|(?:^|[\n.!?])\s*(?:i am|i'm|i’m)\s+(?:actively\s+)?looking for (?:a |my next )?(?:job|role|opportunity)|open to work/u.test(
      value,
    )
  )
    return result('candidate');
  const explicitHiring =
    /ищем|требуется|нанимаем|открыт[аы]\s+(?:позици|ваканси)|ищу\s+(?:frontend|full[ -]?stack|фронт|фулл?стек|react|vue|angular)|в\s+поиске\s+.{0,30}(?:разработчика|инженера)|\bhiring\b|we(?:'re| are|’re) looking|join our team/u.test(
      value,
    );
  const promotion =
    /курс[аыу]?\b|обучени|вебинар|менторств|certification|bootcamp|training program|enroll|скидка/u.test(
      value,
    );
  if (
    !context.listing &&
    promotion &&
    (!explicitHiring ||
      /^(?:[^\n.!?]{0,50})(?:курс|обучени|вебинар|bootcamp|certification)/u.test(
        value,
      ))
  )
    return result('promotion');
  if (
    !context.listing &&
    !explicitHiring &&
    !/вакансия|#ваканси|\bvacancy\b/u.test(value)
  )
    return result('no_hiring');
  // A clear role in the title or recruiting sentence outranks incidental team mentions.
  const sentences = value.split(/[\n.!?]/);
  const lead =
    title ??
    sentences.find((line) =>
      /ищем|требуется|нанимаем|ищу|hiring|looking/u.test(line),
    ) ??
    sentences.find((line) => /ваканси/u.test(line)) ??
    sentences[0]!;
  const primary = detectRoles(lead);
  if (!primary.length && (backend.test(lead) || infrastructure.test(lead)))
    return result('no_role');
  let roles = primary;
  if (!roles.length) {
    const responsibilities =
      value.match(
        /(?:обязанности|задачи|responsibilities|you will|основные задачи)[\s\S]*/u,
      )?.[0] ?? value;
    roles = detectRoles(responsibilities);
    if (
      !roles.length &&
      /(?:разработк[аиу]|build|develop)[^.!?\n]{0,60}(?:интерфейс|user interfaces|react|vue|angular)/u.test(
        responsibilities,
      )
    )
      roles = ['frontend'];
  }
  if (!roles.length) return result('no_role');
  return result(
    language.language === 'none' ? 'no_language' : 'matched',
    roles,
  );
}
export function classify(
  text: string,
  context: { title?: string | undefined; listing?: boolean } = {},
): Classification {
  const sections = splitVacancies(text);
  if (sections.length === 1) return classifySection(text, context);
  const decisions = sections.map((section) =>
    classifySection(section.text, { ...context, title: section.title }),
  );
  const eligible = decisions.filter(
    (decision) => vacancyRoles(decision).length,
  );
  if (eligible.length) {
    const first = eligible[0]!;
    return {
      ...first,
      roles: [...new Set(eligible.flatMap((decision) => decision.roles))],
      reason: 'matched',
    };
  }
  return decisions.find((decision) => decision.roles.length) ?? decisions[0]!;
}
export function classifyPost(post: Post): Classification {
  return classify(post.text, {
    title: post.title,
    listing: post.kind === 'job',
  });
}
export function vacancyRoles(decision: Classification): Role[] {
  return decision.language !== 'none' && decision.reason === 'matched'
    ? decision.roles.filter((role) => role !== 'devops')
    : [];
}
/** Keep each role's requirements and closure state scoped to that vacancy. */
export function assessedCandidates(
  post: Post,
): { post: Post; decision: Classification }[] {
  const sections =
    post.kind === 'job' ? [{ text: post.text }] : splitVacancies(post.text);
  return sections.map((section) => {
    const candidate: Post = {
      ...post,
      text: section.text,
      ...(section.title ? { title: section.title } : {}),
    };
    return { post: candidate, decision: classifyPost(candidate) };
  });
}

export function vacancyCandidates(
  post: Post,
): { post: Post; decision: Classification }[] {
  return assessedCandidates(post).filter(
    (candidate) => vacancyRoles(candidate.decision).length > 0,
  );
}
