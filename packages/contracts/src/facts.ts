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
  const salary = lines
    .map((line) => {
      const content = line.replace(
        /^[\s\p{Extended_Pictographic}\p{Emoji_Presentation}•-]+/gu,
        '',
      );
      const labelled =
        /(?:salary|compensation|pay range|зарплат[аы]|ставка|оклад|вилка)\s*[:—–-]?\s*/iu.exec(
          content,
        );
      const amount = labelled
        ? content.slice(labelled.index + labelled[0].length)
        : content;
      return amount.match(
        /^(?:(?:от|до|from|up to) +)?(?:[$€£₽] *\d+(?:[., ]\d{3})*(?:[.,]\d{1,2})?[kк]?(?: *[-–—] *[$€£₽]? *\d+(?:[., ]\d{3})*(?:[.,]\d{1,2})?[kк]?)?|\d+(?:[., ]\d{3})*[kк]?(?: *[-–—] *\d+(?:[., ]\d{3})*[kк]?)? *(?:USD|EUR|USDT|RUB|руб(?:лей|ля)?|тыс\.? *руб)(?!\p{L}))/iu,
      )?.[0];
    })
    .find(Boolean);
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
  if (work && work !== location) facts.workFormat = work.slice(0, 120);
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
