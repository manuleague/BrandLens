// Utilitare fără dependențe: normalizare text, domenii, HTTP, statistici.

export function normalize(s: string): string {
  return s
    .toLowerCase()
    .replace(/[şș]/g, 's')
    .replace(/[ţț]/g, 't')
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’`´]/g, "'");
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function domainOf(url: string): string {
  try {
    const h = new URL(url.startsWith('http') ? url : `https://${url}`).hostname.toLowerCase();
    return h.replace(/^www\./, '');
  } catch {
    return url.toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0];
  }
}

/** true dacă `host` este `domain` sau un subdomeniu al lui. */
export function sameSite(host: string, domain: string): boolean {
  const h = domainOf(host);
  const d = domainOf(domain);
  return h === d || h.endsWith('.' + d);
}

export function uid(prefix = ''): string {
  const r = crypto.getRandomValues(new Uint8Array(9));
  return prefix + Array.from(r, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 14);
}

export function digits(s: string): string {
  return s.replace(/\D/g, '');
}

/** Normalizează un telefon românesc la ultimele 9 cifre (fără prefix țară/0). */
export function phoneKey(s: string): string {
  const d = digits(s);
  return d.slice(-9);
}

export function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n));
}

/** Interval Wilson 95% pentru o proporție — transparența eșantionului. */
export function wilson(k: number, n: number): [number, number] {
  if (n === 0) return [0, 0];
  const z = 1.96;
  const p = k / n;
  const den = 1 + (z * z) / n;
  const center = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [clamp(center - half, 0, 1), clamp(center + half, 0, 1)];
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export const BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36 BrandLensAudit/1.0';

export interface FetchResult {
  url: string;
  finalUrl: string;
  status: number;
  headers: Record<string, string>;
  body: string;
  ms: number;
  error?: string;
}

export async function httpGet(
  url: string,
  opts: { ua?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<FetchResult> {
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 15000);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctrl.signal,
      headers: {
        'user-agent': opts.ua ?? BROWSER_UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
        'accept-language': 'ro-RO,ro;q=0.9,en;q=0.7',
      },
    });
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => (headers[k] = v));
    const max = opts.maxBytes ?? 3_000_000;
    let body = '';
    if (res.body) {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        body += dec.decode(value, { stream: true });
        if (total > max) {
          await reader.cancel();
          break;
        }
      }
    }
    return { url, finalUrl: res.url || url, status: res.status, headers, body, ms: Date.now() - t0 };
  } catch (e) {
    return { url, finalUrl: url, status: 0, headers: {}, body: '', ms: Date.now() - t0, error: String((e as Error).message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

export async function pool<T, R>(items: T[], n: number, fn: (t: T, i: number) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}
