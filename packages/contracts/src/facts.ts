import type { Post } from './index.js';
export interface VacancyFacts {
  salary?: string;
  location?: string;
  workFormat?: string;
  seniority?: string;
  english?: string;
}
/** Extract only statements present in the source; missing fields stay absent. */
export function vacancyFacts(post: Post): VacancyFacts {
  const lines = post.text
    .split(/[\n;]+/)
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const facts: VacancyFacts = {};
  const salary = post.text.match(
    /(?:[$€£₽]\s*\d[\d\s.,]*(?:[kк]|\s*[-–—]\s*[$€£₽]?\s*\d[\d\s.,]*[kк]?)?|(?:от\s+|до\s+|from\s+|up to\s+)?\d[\d\s.,]*(?:[kк])?(?:\s*[-–—]\s*\d[\d\s.,]*[kк]?)?\s*(?:USD|EUR|RUB|USDT|руб(?:лей|ля)?|доллар(?:ов|а)?|тыс\.?\s*руб))/iu,
  )?.[0];
  if (salary) facts.salary = salary.replace(/\s+/g, ' ').trim().slice(0, 100);
  const location =
    post.location ||
    lines.find((line) =>
      /^(?:[\p{Extended_Pictographic}\s]*)(?:location|локация|география|место работы|страна|страны|только из)\s*[:—-]/iu.test(
        line,
      ),
    );
  if (location) facts.location = location.slice(0, 140);
  const work = lines.find((line) =>
    /remote|удал[её]н|onsite|on-site|офис|гибрид|hybrid/iu.test(line),
  );
  if (work) facts.workFormat = work.slice(0, 120);
  const seniority = [post.title ?? '', post.text]
    .join('\n')
    .match(
      /\b(?:junior|middle|mid-level|senior|lead|staff|principal)\b|младший|старший|ведущий/iu,
    )?.[0];
  if (seniority) facts.seniority = seniority;
  const english = lines.find(
    (line) =>
      /english|английск/iu.test(line) &&
      /[abc][12]|fluent|required|mandatory|intermediate|advanced|обязател|уровень|свободн/iu.test(
        line,
      ),
  );
  if (english) facts.english = english.slice(0, 140);
  return facts;
}
