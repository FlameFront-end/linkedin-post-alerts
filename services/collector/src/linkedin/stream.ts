/** Decode JSON without changing escaped quotes inside user text. */
export function readJson(input: string, start: number): unknown {
  const opening = input[start];
  if (opening !== '{' && opening !== '[' && opening !== '"') return;
  let depth = 0,
    quoted = false,
    escaped = false;
  for (let i = start; i < input.length; i++) {
    const c = input[i];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') {
        quoted = false;
        if (opening === '"') {
          try {
            return JSON.parse(input.slice(start, i + 1));
          } catch {
            return;
          }
        }
      }
    } else if (c === '"') quoted = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) {
      try {
        return JSON.parse(input.slice(start, i + 1));
      } catch {
        return;
      }
    }
  }
}
export function streamText(input: string, html: boolean): string {
  if (!html) return input;
  const decoded: string[] = [input];
  for (const match of input.matchAll(/(?:self\.)?__next_f\.push\(/g)) {
    const value = readJson(input, match.index + match[0].length);
    if (Array.isArray(value) && typeof value[1] === 'string')
      decoded.push(value[1]);
  }
  return decoded.join('\n');
}
export function streamRecords(input: string): Map<string, unknown> {
  const records = new Map<string, unknown>();
  for (const match of input.matchAll(/(?:^|\n)([0-9a-f]+):/g)) {
    const at = match.index + match[0].length;
    if (input[at] === 'T') {
      const length = input.slice(at + 1).match(/^([0-9a-f]+),/);
      if (length) {
        const from = at + 1 + length[0].length;
        records.set(
          match[1]!,
          Buffer.from(input.slice(from))
            .subarray(0, parseInt(length[1]!, 16))
            .toString('utf8'),
        );
      }
    } else {
      const value = readJson(input, at);
      if (value !== undefined) records.set(match[1]!, value);
    }
  }
  return records;
}
export function renderText(
  value: unknown,
  records = new Map<string, unknown>(),
  visited = new Set<string>(),
  depth = 0,
): string {
  if (depth > 30) return '';
  if (typeof value === 'string') {
    if (value.startsWith('$$')) return value.slice(1);
    const ref = value.match(/^\$(?:L)?([0-9a-f]+)$/);
    if (!ref || (!records.has(ref[1]!) && /^\$\d/.test(value))) return value;
    const id = ref[1]!;
    if (visited.has(id)) return '';
    const next = new Set(visited).add(id);
    return renderText(records.get(id), records, next, depth + 1);
  }
  if (Array.isArray(value)) {
    if (value[0] === '$')
      return value[1] === 'br'
        ? '\n'
        : renderText(value[3], records, visited, depth + 1);
    return value
      .map((item) => renderText(item, records, visited, depth + 1))
      .join('');
  }
  if (value && typeof value === 'object') {
    const node = value as Record<string, unknown>;
    return renderText(node.children ?? node.text, records, visited, depth + 1);
  }
  return '';
}
