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
  let layer = input;
  for (let depth = 0; depth < 3; depth++) {
    const extracted: string[] = [];
    for (const match of layer.matchAll(/"(?:\\.|[^"\\])*"/g)) {
      if (
        !match[0].includes('PaginationRequest') &&
        !match[0].includes('translatable-commentary')
      )
        continue;
      try {
        const value: unknown = JSON.parse(match[0]);
        if (typeof value === 'string' && value !== match[0])
          extracted.push(value);
      } catch {
        /* A JavaScript literal that is not JSON is not interpreted. */
      }
    }
    if (!extracted.length) break;
    layer = extracted.join('\n');
    decoded.push(layer);
  }
  return decoded.join('\n');
}
export function streamRecords(input: string): Map<string, unknown> {
  const records = new Map<string, unknown>();
  const bytes = Buffer.from(input);
  let offset = 0;
  while (offset < bytes.length) {
    const newline = bytes.indexOf(10, offset);
    const end = newline === -1 ? bytes.length : newline;
    const line = bytes.toString('utf8', offset, end);
    const header = /^([0-9a-f]+):/.exec(line);
    if (header) {
      const id = header[1]!;
      const body = line.slice(header[0].length);
      const length = /^T([0-9a-f]+),/.exec(body);
      if (length) {
        const start = offset + header[0].length + length[0].length;
        const size = Number.parseInt(length[1]!, 16);
        if (!Number.isSafeInteger(size) || size > bytes.length - start) break;
        records.set(id, bytes.toString('utf8', start, start + size));
        offset = start + size;
        continue;
      }
      const value = readJson(body, 0);
      if (value !== undefined) records.set(id, value);
    }
    offset = end + 1;
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
    const ref = value.match(/^\$(?:L)?([0-9a-f]+)((?::[\w-]+)*)$/);
    if (!ref)
      return value.replace(
        /\$[0-9a-f]+(?::(?:props|children|initialContent|textProps|\d+))+/g,
        '',
      );
    const id = ref[1]!;
    const path = ref[2]!;
    if (!path && !records.has(id) && /^\$\d+$/.test(value)) return value;
    if (visited.has(value)) return '';
    let target = records.get(id);
    for (const key of path.split(':').slice(1)) {
      if (key === 'props' && Array.isArray(target) && target[0] === '$') {
        target = target[3];
        continue;
      }
      if (!target || typeof target !== 'object' || !Object.hasOwn(target, key))
        return '';
      target = (target as Record<string, unknown>)[key];
    }
    return renderText(target, records, new Set(visited).add(value), depth + 1);
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
    return renderText(
      node.children ?? node.textProps ?? node.text,
      records,
      visited,
      depth + 1,
    );
  }
  return '';
}
