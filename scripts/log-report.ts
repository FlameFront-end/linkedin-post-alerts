import { readdir, mkdir, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
const root = resolve(process.env.LOG_ROOT ?? '.local/logs');
async function files(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const result: string[] = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else if (
      entry.isFile() &&
      /^[a-z][a-z0-9-]*-\d{4}-\d{2}-\d{2}\.jsonl(?:\.[1-5])?$/.test(entry.name)
    )
      result.push(path);
  }
  return result.sort();
}
const counts: Record<string, number> = {},
  levels: Record<string, number> = {};
const latest: Record<string, unknown> = {},
  issues: unknown[] = [],
  invalid: Record<string, number> = {};
let total = 0,
  first: string | undefined,
  last: string | undefined;
await mkdir(root, { recursive: true, mode: 0o700 });
const paths = await files(root);
for (const path of paths) {
  const reader = createInterface({
    input: createReadStream(path),
    crlfDelay: Infinity,
  });
  for await (const line of reader) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as Record<string, unknown>;
      if (
        typeof entry.timestamp !== 'string' ||
        typeof entry.service !== 'string' ||
        typeof entry.event !== 'string'
      )
        throw Error('invalid_record');
      total++;
      first = !first || entry.timestamp < first ? entry.timestamp : first;
      last = !last || entry.timestamp > last ? entry.timestamp : last;
      const key = entry.service + ':' + entry.event;
      counts[key] = (counts[key] ?? 0) + 1;
      const level = String(entry.level ?? 'info');
      levels[level] = (levels[level] ?? 0) + 1;
      const old = latest[entry.service] as { timestamp: string } | undefined;
      if (!old || entry.timestamp > old.timestamp)
        latest[entry.service] = entry;
      if (level === 'warn' || level === 'error') {
        issues.push(entry);
        if (issues.length > 100) {
          issues.sort((a, b) =>
            String((a as Record<string, unknown>).timestamp).localeCompare(
              String((b as Record<string, unknown>).timestamp),
            ),
          );
          issues.splice(0, issues.length - 50);
        }
      }
    } catch {
      invalid[path] = (invalid[path] ?? 0) + 1;
    }
  }
}
issues.sort((a, b) =>
  String((a as Record<string, unknown>).timestamp).localeCompare(
    String((b as Record<string, unknown>).timestamp),
  ),
);
let status: unknown;
try {
  const r = await fetch('http://127.0.0.1:3101/status', {
    signal: AbortSignal.timeout(3000),
  });
  if (r.ok) status = await r.json();
  else status = { httpStatus: r.status };
} catch {
  status = { available: false };
}
const report = {
  generatedAt: new Date().toISOString(),
  files: paths.length,
  records: total,
  first,
  last,
  levels,
  counts,
  latest,
  recentIssues: issues.slice(-50),
  invalid,
  status,
};
const directory = join(root, 'reports');
await mkdir(directory, { recursive: true, mode: 0o700 });
const output = join(
  directory,
  `report-${new Date().toISOString().replace(/[:.]/g, '-')}.json`,
);
await writeFile(output, JSON.stringify(report, null, 2) + '\n', {
  mode: 0o600,
});
// Keep the newest 20 reports; event files have their own rotation policy.
for (const name of (await readdir(directory))
  .filter((name) => /^report-[\dTZ-]+\.json$/.test(name))
  .sort()
  .slice(0, -20)) {
  const { unlink } = await import('node:fs/promises');
  await unlink(join(directory, name));
}
console.log(
  JSON.stringify({
    report: output,
    files: paths.length,
    records: total,
    levels,
    invalidLines: Object.values(invalid).reduce((a, b) => a + b, 0),
    networkRequests: 0,
  }),
);
