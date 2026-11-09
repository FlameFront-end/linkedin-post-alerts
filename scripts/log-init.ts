import { mkdir, chmod } from 'node:fs/promises';
import { resolve, join } from 'node:path';
const root = resolve(process.env.LOG_ROOT ?? '.local/logs');
await mkdir(root, { recursive: true, mode: 0o700 });
for (const name of ['collector', 'processor', 'notifier', 'ocr', 'migrate']) {
  const path = join(root, name);
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}
console.log(JSON.stringify({ directory: root, services: 5 }));
