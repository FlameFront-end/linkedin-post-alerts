import { classifyPost } from '../../../packages/contracts/src/classifier.js';
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
  const title =
    post.title ??
    (hasHeadline
      ? first
      : value.roles.map((role) => roleLabels[role]).join(' / '));
  const body = shorten(
    (hasHeadline ? lines.slice(1) : lines)
      .filter((line) => !/^#[\p{L}\d_]+(?:\s+#[\p{L}\d_]+)*$/u.test(line))
      .join('\n'),
    750,
  );
  const author = shorten(
    post.author.split(/\s*[•·]\s*/)[0]?.trim() || 'LinkedIn',
    100,
  );
  const category =
    (post.kind === 'job' ? 'Вакансия · ' : '') +
    value.roles.map((role) => roleLabels[role]).join(' / ');
  const required = classifyPost(post).language === 'required';
  const badge = required
    ? ' · Русский обязателен'
    : value.russian
      ? preferRussian
        ? ' ⭐ RU'
        : ' · RU'
      : '';
  const meta = `👤 ${author} · ${bangkok.format(new Date(post.publishedAt))} (Бангкок)`;
  return html
    ? `<b>${escape(title)}</b>\n${escape(category + badge)}\n${escape(meta)}\n\n${escape(body)}\n\n<a href="${escape(post.url)}">${post.kind === 'job' ? 'Открыть вакансию' : 'Открыть пост'} в LinkedIn ↗</a>`
    : `${title}\n${category + badge}\n${meta}\n\n${body}\n\n${post.url}`;
}
export function formatAlert(value: Alert): string {
  return `⚠️ linkedin-post-alerts: ${value.code}\n${value.message}\n${value.at}`.slice(
    0,
    4000,
  );
}
