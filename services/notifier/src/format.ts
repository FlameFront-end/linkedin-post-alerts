import { classifyPost } from '../../../packages/contracts/src/classifier.js';
import { vacancyFacts } from '../../../packages/contracts/src/facts.js';
import type {
  Alert,
  Notification,
} from '../../../packages/contracts/src/index.js';
const roleLabels = {
  frontend: 'Frontend',
  fullstack: 'Full-stack',
  devops: 'DevOps',
};
const bangkok = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'Asia/Bangkok',
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
});
const dateOnly = new Intl.DateTimeFormat('ru-RU', {
  timeZone: 'UTC',
  day: 'numeric',
  month: 'short',
});
const escape = (text: string) =>
  text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
function shorten(text: string, limit: number) {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit - 1);
  const boundary = head.lastIndexOf(' ');
  return (
    (boundary > limit * 0.8
      ? head.slice(0, boundary)
      : head.replace(/[\uD800-\uDBFF]$/, '')) + '…'
  );
}
export function formatNotification(
  value: Notification,
  preferRussian: boolean,
  html = false,
): string {
  const { post } = value;
  const lines = post.text
    .split(/\r?\n/)
    .map((line) => line.replace(/[^\S\r\n]+/g, ' ').trim())
    .filter(Boolean);
  const first = lines[0] ?? '';
  const hasHeadline =
    !post.title &&
    first.length <= 100 &&
    lines.length > 1 &&
    !first.startsWith('#');
  const title = shorten(
    post.title ??
      (hasHeadline
        ? first
        : value.roles.map((role) => roleLabels[role]).join(' / ')),
    160,
  );
  const body = (hasHeadline ? lines.slice(1) : lines)
    .filter((line) => !/^#[\p{L}\d_]+(?:\s+#[\p{L}\d_]+)*$/u.test(line))
    .join('\n');
  const author = shorten(
    post.author.split(/\s*[•·]\s*/)[0]?.trim() || 'LinkedIn',
    100,
  );
  const decision = classifyPost(post);
  const badge =
    decision.language === 'required'
      ? ' · Русский обязателен'
      : value.russian
        ? preferRussian
          ? ' ⭐ RU'
          : ' · RU'
        : '';
  const category =
    (value.updated ? 'Обновлено · ' : '') +
    (post.kind === 'job' ? 'Вакансия · ' : '') +
    value.roles.map((role) => roleLabels[role]).join(' / ') +
    badge;
  const published =
    post.publishedPrecision === 'day'
      ? dateOnly.format(new Date(post.publishedAt))
      : bangkok.format(new Date(post.publishedAt)) + ' (Бангкок)';
  const meta =
    (author === 'LinkedIn author' ? 'LinkedIn' : `👤 ${author}`) +
    ' · ' +
    published;
  const facts = vacancyFacts(post);
  const fields = [
    facts.salary && `💰 ${facts.salary}`,
    facts.location && `📍 ${facts.location}`,
    facts.workFormat && `🏠 ${facts.workFormat}`,
    facts.seniority && `🧑‍💻 ${facts.seniority}`,
    facts.english && `🇬🇧 ${facts.english}`,
    decision.evidence && `🇷🇺 ${shorten(decision.evidence, 160)}`,
  ].filter((item): item is string => !!item);
  const warning = post.textIncomplete
    ? '⚠️ Текст получен не полностью — проверьте оригинал.'
    : post.ocrApplied
      ? 'Текст распознан с изображения — проверьте оригинал.'
      : '';
  const prefix = () =>
    [
      html ? `<b>${escape(title)}</b>` : title,
      ...[category, meta, ...fields].map((line) =>
        html ? escape(line) : line,
      ),
    ].join('\n');
  const link = html
    ? `<a href="${escape(post.url)}">${post.kind === 'job' ? 'Открыть вакансию' : 'Открыть пост'} в LinkedIn ↗</a>`
    : post.url;
  let limit = 750;
  const build = () =>
    [
      prefix(),
      html ? escape(shorten(body, limit)) : shorten(body, limit),
      warning,
      link,
    ]
      .filter(Boolean)
      .join('\n\n');
  while (build().length > 4000 && limit > 100) limit -= 50;
  while (build().length > 4000 && fields.length) fields.pop();
  return build();
}
export function formatAlert(value: Alert): string {
  return `⚠️ linkedin-post-alerts: ${value.code}\n${value.message}\n${value.at}`.slice(
    0,
    4000,
  );
}
