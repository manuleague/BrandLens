// Parser HTML minimal (regex), suficient pentru audit SEO/GEO. Fără dependențe.

export interface ParsedPage {
  title: string;
  metaDescription: string;
  metaRobots: string;
  canonical: string;
  lang: string;
  h1: string[];
  h2: string[];
  h3: string[];
  links: { href: string; text: string }[];
  jsonLd: unknown[];
  jsonLdErrors: number;
  schemaTypes: string[];
  text: string;
  words: number;
  scripts: number;
  imagesNoAlt: number;
  images: number;
  telLinks: string[];
  questionHeadings: string[];
  modified: string;
  hasTable: boolean;
  listItems: number;
  ogTitle: string;
}

const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export function decodeEntities(s: string): string {
  return s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const code = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

function stripTags(s: string): string {
  return decodeEntities(s.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function attr(tag: string, name: string): string {
  const m = tag.match(new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return m ? decodeEntities(m[2] ?? m[3] ?? m[4] ?? '') : '';
}

function metaContent(html: string, key: string, by = 'name'): string {
  const re = /<meta\b[^>]*>/gi;
  for (const m of html.match(re) ?? []) {
    if (attr(m, by).toLowerCase() === key) return attr(m, 'content');
  }
  return '';
}

function tagTexts(html: string, tag: string): string[] {
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)</${tag}>`, 'gi');
  const out: string[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const t = stripTags(m[1]);
    if (t) out.push(t);
  }
  return out;
}

export function collectTypes(node: unknown, out: Set<string>): void {
  if (Array.isArray(node)) {
    node.forEach((n) => collectTypes(n, out));
    return;
  }
  if (node && typeof node === 'object') {
    const o = node as Record<string, unknown>;
    const t = o['@type'];
    if (typeof t === 'string') out.add(t);
    if (Array.isArray(t)) t.forEach((x) => typeof x === 'string' && out.add(x));
    for (const v of Object.values(o)) if (v && typeof v === 'object') collectTypes(v, out);
  }
}

/** Găsește primul nod JSON-LD al cărui @type este în `types`. */
export function findSchemaNode(jsonLd: unknown[], types: string[]): Record<string, unknown> | null {
  const want = new Set(types.map((t) => t.toLowerCase()));
  const stack: unknown[] = [...jsonLd];
  while (stack.length) {
    const n = stack.shift();
    if (Array.isArray(n)) {
      stack.push(...n);
      continue;
    }
    if (n && typeof n === 'object') {
      const o = n as Record<string, unknown>;
      const t = o['@type'];
      const ts = (Array.isArray(t) ? t : [t]).filter((x): x is string => typeof x === 'string').map((x) => x.toLowerCase());
      if (ts.some((x) => want.has(x))) return o;
      if (Array.isArray(o['@graph'])) stack.push(...(o['@graph'] as unknown[]));
      for (const v of Object.values(o)) if (v && typeof v === 'object') stack.push(v);
    }
  }
  return null;
}

export function parseHtml(html: string): ParsedPage {
  const jsonLd: unknown[] = [];
  let jsonLdErrors = 0;
  const ldRe = /<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let m: RegExpExecArray | null;
  while ((m = ldRe.exec(html))) {
    try {
      jsonLd.push(JSON.parse(m[1].trim()));
    } catch {
      jsonLdErrors++;
    }
  }
  const types = new Set<string>();
  collectTypes(jsonLd, types);

  const scripts = (html.match(/<script\b/gi) ?? []).length;
  const body = (html.match(/<body\b[^>]*>([\s\S]*)<\/body>/i)?.[1] ?? html)
    .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript\b[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<template\b[\s\S]*?<\/template>/gi, ' ')
    .replace(/<svg\b[\s\S]*?<\/svg>/gi, ' ');
  const text = stripTags(body.replace(/<\/(p|div|li|h\d|tr|br|section|article)>/gi, '\n'));

  const links: { href: string; text: string }[] = [];
  const aRe = /<a\b([^>]*)>([\s\S]*?)<\/a>/gi;
  while ((m = aRe.exec(html))) {
    const href = attr(`<a ${m[1]}>`, 'href');
    if (href) links.push({ href, text: stripTags(m[2]).slice(0, 120) });
  }
  const imgs = html.match(/<img\b[^>]*>/gi) ?? [];
  const h2 = tagTexts(html, 'h2');
  const h3 = tagTexts(html, 'h3');
  const canonicalTag = (html.match(/<link\b[^>]*rel\s*=\s*["']canonical["'][^>]*>/i) ?? [''])[0];

  return {
    title: tagTexts(html, 'title')[0] ?? '',
    metaDescription: metaContent(html, 'description'),
    metaRobots: metaContent(html, 'robots').toLowerCase(),
    canonical: canonicalTag ? attr(canonicalTag, 'href') : '',
    lang: attr((html.match(/<html\b[^>]*>/i) ?? [''])[0], 'lang'),
    h1: tagTexts(html, 'h1'),
    h2,
    h3,
    links,
    jsonLd,
    jsonLdErrors,
    schemaTypes: [...types],
    text,
    words: text ? text.split(/\s+/).length : 0,
    scripts,
    images: imgs.length,
    imagesNoAlt: imgs.filter((t) => !/\salt\s*=\s*["'][^"']+/i.test(t)).length,
    telLinks: links.filter((l) => l.href.toLowerCase().startsWith('tel:')).map((l) => l.href.slice(4)),
    questionHeadings: [...h2, ...h3, ...tagTexts(html, 'h4'), ...tagTexts(html, 'summary'), ...tagTexts(html, 'dt')].filter((h) => /\?\s*$/.test(h)),
    modified:
      metaContent(html, 'article:modified_time', 'property') ||
      (html.match(/"dateModified"\s*:\s*"([^"]+)"/)?.[1] ?? '') ||
      (text.match(/(actualizat|updated|ultima actualizare)[^0-9]{0,20}(\d{1,2}[./-]\d{1,2}[./-]\d{2,4}|\d{4}-\d{2}-\d{2})/i)?.[2] ?? ''),
    hasTable: /<table\b/i.test(html),
    listItems: (html.match(/<li\b/gi) ?? []).length,
    ogTitle: metaContent(html, 'og:title', 'property'),
  };
}

/** Pagină care probabil randează conținutul doar din JavaScript (problemă pentru crawlerele AI). */
export function looksJsOnly(p: ParsedPage, rawHtml: string): boolean {
  const appShell = /<div\s+id=["'](root|app|__next|__nuxt)["'][^>]*>\s*<\/div>/i.test(rawHtml);
  return p.words < 80 && (p.scripts >= 3 || appShell);
}
