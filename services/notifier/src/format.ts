import type { Notification } from '../../../packages/contracts/src/index.js';
export function formatNotification(
  value: Notification,
  preferRussian: boolean,
): string {
  const priority = preferRussian && value.russian ? '⭐ ' : '';
  const header = `${priority}${value.roles.map((role) => (role === 'frontend' ? 'Frontend' : 'DevOps')).join(' / ')}${value.russian ? ' · RU' : ''}`;
  // Plain text, no HTML/Markdown injection from untrusted posts.
  return `${header}\n${value.post.author}\nОпубликовано: ${value.post.publishedAt}\n\n${value.post.text.slice(0, 2600)}\n\n${value.post.url}`.slice(
    0,
    4000,
  );
}
