// Turning spec-supplied text into contract-safe Markdown, attributes and slugs.
// Spec descriptions are tenant content: they may hold raw HTML, relative links or braces, none of
// which a guide page may contain.

/** First paragraph of a spec description, reduced to plain text. */
export function plainText(input: string | undefined, max = 0): string {
  if (!input) return '';
  let t = input.replace(/\r\n?/g, '\n').trim();
  t = t.replace(/<(script|style)\b[\s\S]*?<\/\1\s*>/gi, '').replace(/^\s{0,3}#+\s.*$/gm, '').trim();
  t = t.split(/\n\s*\n/)[0] ?? '';
  t = t
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/<[^>\n]+>/g, '')
    .replace(/\*{1,3}([^*\n]+)\*{1,3}/g, '$1')
    .replace(/(^|[\s(])_{1,3}([^_\n]+)_{1,3}(?=$|[\s).,;:!?])/g, '$1$2')
    .replace(/`/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (max && t.length > max) {
    // End on a whole sentence when one closes in the second half; otherwise cut at a word.
    // Either way the cut is marked.
    const cut = t.slice(0, max - 1);
    const ends = [...t.slice(0, max + 1).matchAll(/[.!?](?=\s)/g)].map((m) => m.index + 1);
    const sentence = ends.filter((i) => i <= max - 2 && i >= max / 2).at(-1);
    t = sentence ? t.slice(0, Math.min(sentence, max - 2)) + ' …' : cut.slice(0, Math.max(cut.lastIndexOf(' '), Math.floor(max / 2))).replace(/[\s,;:.]+$/, '') + '…';
  }
  return t;
}

/** Plain text for frontmatter: no angle brackets or braces. */
export function meta(input: string | undefined, max = 0): string {
  return plainText(input, max).replace(/[<>{}\[\]*~]/g, '').replace(/&(?=#?\w+;)/g, '').replace(/\s+/g, ' ').trim();
}

/** Plain text, escaped so it is inert when placed in a Markdown paragraph or table cell. */
export function prose(input: string | undefined, max = 0): string {
  return plainText(input, max)
    .replace(/([\\<>{}\[\]|*_#~`&])/g, '\\$1')
    .replace(/^([-+=])/, '\\$1')
    .replace(/^(\d+)([.)])/, '$1\\$2');
}

/** Text for a component attribute: one line, no quotes or braces. */
export function attr(input: string, max = 80): string {
  const t = plainText(input, max)
    .replace(/"/g, "'")
    .replace(/\{+([^{}]*)\}+/g, ':$1')
    .replace(/[<>{}]/g, '')
    .replace(/&(?=#?\w+;)/g, '');
  return t.replace(/[.\s]+$/, '');
}

/** Inline code. Falls back to escaped prose when the text cannot sit safely in a code span. */
export function code(input: string): string {
  return /[`\n\r|\\]|\{\{/.test(input) || input.trim() === '' ? prose(input) : '`' + input + '`';
}

export function slugify(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Human words from an identifier or path segment: `payment_intents` becomes `payment intents`. */
export function words(input: string): string {
  return input
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function plural(noun: string): string {
  if (/s$/.test(noun)) return noun;
  if (/[^aeiou]y$/.test(noun)) return noun.slice(0, -1) + 'ies';
  if (/(x|ch|sh)$/.test(noun)) return noun + 'es';
  return noun + 's';
}

export function singular(noun: string): string {
  const parts = noun.split(' ');
  let w = parts.pop()!;
  if (/ies$/.test(w)) w = w.slice(0, -3) + 'y';
  else if (/(ss|x|ch|sh)es$/.test(w)) w = w.slice(0, -2);
  else if (/s$/.test(w) && !/(ss|us|is)$/.test(w)) w = w.slice(0, -1);
  return [...parts, w].join(' ');
}

export const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** YAML frontmatter. JSON strings are valid YAML double-quoted scalars. */
export function frontmatter(fields: Record<string, string | string[] | undefined>): string {
  const lines = ['---'];
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined || (Array.isArray(v) && v.length === 0)) continue;
    lines.push(`${k}: ${Array.isArray(v) ? '[' + v.map((x) => JSON.stringify(x)).join(', ') + ']' : JSON.stringify(v)}`);
  }
  lines.push('---', '');
  return lines.join('\n');
}
