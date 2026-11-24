// Crawler politicos: robots.txt, sitemap, pagini interne prioritare, test live cu UA-urile boturilor AI.

import { BOTS } from './bots.ts';
import { looksJsOnly, parseHtml, type ParsedPage } from './html.ts';
import { isAllowed, parseRobots, type RobotsTxt } from './robots.ts';
import type { BotAccess } from './types.ts';
import { gunzipSync } from 'node:zlib';
import { BROWSER_UA, httpGet, pool, sameSite, sleep, type FetchResult } from './util.ts';

export interface CrawledPage {
  url: string;
  status: number;
  ms: number;
  headers: Record<string, string>;
  html: string;
  parsed: ParsedPage;
  jsOnly: boolean;
  noindex: boolean;
}

export interface CrawlData {
  origin: string;
  home: CrawledPage | null;
  homeFetch: FetchResult;
  pages: CrawledPage[];
  robots: RobotsTxt | null;
  robotsStatus: number;
  sitemapUrls: string[];
  sitemapFound: boolean;
  sitemapStatus: number;
  sitemap: SitemapInfo;
  llmsTxt: boolean;
  bots: BotAccess[];
  notes: string[];
}

const PRIORITY_HINTS = /(meniu|menu|despre|about|contact|servicii|services|preturi|prețuri|pricing|faq|intrebari|întrebări|livrare|delivery|rezerv|locati|program|echipa|team|produse|products|blog|recenzii|reviews)/i;

function absolutize(href: string, base: string): string | null {
  try {
    const u = new URL(href, base);
    if (!/^https?:$/.test(u.protocol)) return null;
    u.hash = '';
    return u.toString();
  } catch {
    return null;
  }
}

function toPage(f: FetchResult): CrawledPage {
  const parsed = parseHtml(f.body);
  const xRobots = (f.headers['x-robots-tag'] ?? '').toLowerCase();
  return {
    url: f.finalUrl,
    status: f.status,
    ms: f.ms,
    headers: f.headers,
    html: f.body,
    parsed,
    jsOnly: looksJsOnly(parsed, f.body),
    noindex: parsed.metaRobots.includes('noindex') || xRobots.includes('noindex'),
  };
}

async function fetchSitemapText(url: string): Promise<{ status: number; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: ctrl.signal, headers: { 'user-agent': BROWSER_UA, accept: 'application/xml,text/xml,*/*' } });
    const buf = new Uint8Array(await res.arrayBuffer());
    // Sitemap-uri comprimate (.xml.gz) servite ca fișier binar: le decomprimăm.
    const gz = buf.length > 2 && buf[0] === 0x1f && buf[1] === 0x8b;
    const text = gz ? gunzipSync(buf).toString('utf8') : new TextDecoder().decode(buf);
    return { status: res.status, text };
  } catch {
    return { status: 0, text: '' };
  } finally {
    clearTimeout(t);
  }
}

export interface SitemapInfo {
  urls: string[];
  found: boolean;
  status: number;
  files: number; // fișiere sitemap citite
  declaredTotal: number; // URL-uri numărate în fișierele citite
  indexChildren: number; // sitemap-uri listate în index
}

export async function readSitemaps(urls: string[], limit: number): Promise<SitemapInfo> {
  const out = new Set<string>();
  let found = false;
  let status = 0;
  let files = 0;
  let declaredTotal = 0;
  let indexChildren = 0;
  const queue = [...new Set(urls)];
  const seen = new Set<string>();
  while (queue.length && files < 8) {
    const sm = queue.shift()!;
    if (seen.has(sm)) continue;
    seen.add(sm);
    const r = await fetchSitemapText(sm);
    if (!status) status = r.status;
    if (r.status !== 200 || !/<(urlset|sitemapindex)\b/i.test(r.text)) continue;
    found = true;
    status = 200;
    files++;
    const locs = [...r.text.matchAll(/<loc>\s*(?:<!\[CDATA\[)?\s*([^<\s\]]+)\s*(?:\]\]>)?\s*<\/loc>/gi)].map((m) => m[1].replace(/&amp;/g, '&'));
    if (/<sitemapindex\b/i.test(r.text)) {
      indexChildren += locs.length;
      // eșantion din index: primele + câteva din mijloc (categorii, produse, pagini)
      const pick = [...locs.slice(0, 3), ...locs.slice(Math.floor(locs.length / 2), Math.floor(locs.length / 2) + 2)];
      queue.push(...pick);
    } else {
      declaredTotal += locs.length;
      locs.forEach((l) => out.size < limit && out.add(l));
    }
  }
  return { urls: [...out], found, status, files, declaredTotal, indexChildren };
}

const TRACKING_PARAMS = /^(ref|utm_\w+|gclid|fbclid|mc_cid|mc_eid|srsltid|_ga|from|source)$/i;
const SKIP_PATH = /\/(cart|cos|cosul|checkout|login|logout|register|auth|account|contul-meu|my-account|wishlist|favorite|favorites|compare|cautare|search)(\/|\?|$)/i;
const SKIP_HOST = /^(auth|login|account|accounts|sso|id|my|cdn|static|img|images)\./i;

/** URL canonic pentru deduplicare: fără parametri de tracking, fără fragment, fără slash final. */
export function canonicalUrl(u: string): string {
  try {
    const x = new URL(u);
    x.hash = '';
    for (const k of [...x.searchParams.keys()]) if (TRACKING_PARAMS.test(k)) x.searchParams.delete(k);
    x.hostname = x.hostname.toLowerCase();
    if (x.pathname.length > 1 && x.pathname.endsWith('/')) x.pathname = x.pathname.replace(/\/+$/, '');
    return x.toString().replace(/\?$/, '');
  } catch {
    return u;
  }
}

export async function crawlSite(domainOrUrl: string, opts: { maxPages?: number; liveBotTest?: boolean } = {}): Promise<CrawlData> {
  const maxPages = opts.maxPages ?? 25;
  const notes: string[] = [];
  let start = domainOrUrl.trim();
  if (!/^https?:\/\//i.test(start)) start = `https://${start}`;

  let homeFetch = await httpGet(start);
  if (homeFetch.status === 0 && start.startsWith('https://')) {
    const alt = start.replace('https://', 'http://');
    const r = await httpGet(alt);
    if (r.status) {
      notes.push('Site-ul nu răspunde pe HTTPS; s-a folosit HTTP.');
      homeFetch = r;
    }
  }
  const origin = (() => {
    try {
      return new URL(homeFetch.finalUrl || start).origin;
    } catch {
      return start;
    }
  })();

  const robotsRes = await httpGet(`${origin}/robots.txt`, { timeoutMs: 10000 });
  const robots = robotsRes.status === 200 && !/<html/i.test(robotsRes.body.slice(0, 500)) ? parseRobots(robotsRes.body) : null;

  const llms = await httpGet(`${origin}/llms.txt`, { timeoutMs: 8000, maxBytes: 200_000 });
  const llmsTxt = llms.status === 200 && !/<html/i.test(llms.body.slice(0, 300)) && llms.body.trim().length > 20;

  const smCandidates = robots?.sitemaps.length ? robots.sitemaps : [`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`];
  const sm = await readSitemaps(smCandidates, 400);

  const home = homeFetch.status ? toPage(homeFetch) : null;
  const pages: CrawledPage[] = home ? [home] : [];
  const seen = new Set<string>([homeFetch.finalUrl, start, origin + '/'].map(canonicalUrl));
  const originHost = new URL(origin).hostname;
  const crawlable = (u: string) => {
    try {
      const x = new URL(u);
      return sameSite(x.hostname, originHost) && !SKIP_HOST.test(x.hostname) && !SKIP_PATH.test(x.pathname) && !/\.(pdf|jpe?g|png|gif|webp|svg|zip|mp4|docx?|xml|gz)(\?|$)/i.test(x.pathname);
    } catch {
      return false;
    }
  };

  if (home && home.status < 400) {
    const internal = home.parsed.links
      .map((l) => ({ url: absolutize(l.href, home.url), text: l.text }))
      .filter((l): l is { url: string; text: string } => !!l.url && crawlable(l.url))
      .map((l) => ({ ...l, url: canonicalUrl(l.url) }));
    const scored = new Map<string, number>();
    for (const l of internal) scored.set(l.url, Math.max(scored.get(l.url) ?? 0, PRIORITY_HINTS.test(l.url + ' ' + l.text) ? 3 : 1));
    for (const raw of sm.urls) {
      if (!crawlable(raw)) continue;
      const u = canonicalUrl(raw);
      scored.set(u, Math.max(scored.get(u) ?? 0, PRIORITY_HINTS.test(u) ? 2 : 0.8));
    }
    const candidates = [...scored.entries()]
      .filter(([u]) => !seen.has(u))
      .sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)
      .slice(0, maxPages - 1)
      .map(([u]) => u);
    const fetched = await pool(candidates, 3, async (u) => {
      await sleep(150);
      return httpGet(u);
    });
    for (const f of fetched) {
      const key = canonicalUrl(f.finalUrl);
      if (!f.status || seen.has(key)) continue;
      seen.add(key);
      if (!/html/i.test(f.headers['content-type'] ?? 'text/html')) continue;
      pages.push(toPage(f));
    }
  }

  // Acces boți: robots.txt + test live cu user-agent-ul botului (indiciu pentru blocaje WAF/CDN).
  const bots: BotAccess[] = [];
  const homeOk = homeFetch.status >= 200 && homeFetch.status < 400;
  const live = opts.liveBotTest !== false && homeOk;
  const liveResults = live
    ? await pool(BOTS.filter((b) => b.purpose !== 'training' || b.token === 'GPTBot'), 3, (b) => httpGet(origin + '/', { ua: b.ua, timeoutMs: 12000, maxBytes: 300_000 }))
    : [];
  const liveMap = new Map<string, FetchResult>();
  BOTS.filter((b) => b.purpose !== 'training' || b.token === 'GPTBot').forEach((b, i) => liveResults[i] && liveMap.set(b.token, liveResults[i]));
  // Comparăm cu răspunsul primit de un browser normal: blocat = cod de refuz SAU pagină de tip challenge mult mai mică.
  const baseLen = homeFetch.body.length;
  const challengeTitle = /<title[^>]*>([^<]*(?:just a moment|attention required|access denied|captcha|verify you are human|security check|blocked|forbidden|ddos)[^<]*)<\/title>/i;
  const challengeMarkers = /(cf-chl-|challenge-platform|_incapsula_resource|px-captcha|datadome|akamai bot manager|perimeterx)/i;
  const kb = (n: number) => `${Math.round(n / 1024)} KB`;
  /** Motivul blocării sau undefined dacă răspunsul arată ca pentru un browser. */
  const blockReason = (lr: FetchResult): string | undefined => {
    if (lr.status === 0) return homeOk ? 'fără răspuns (conexiune închisă / timeout)' : undefined;
    if ([401, 403, 406, 429, 451, 503, 511].includes(lr.status)) return `cod de refuz HTTP ${lr.status}`;
    const title = lr.body.slice(0, 20000).match(challengeTitle);
    if (title) return `pagină de verificare (titlu „${title[1].trim().slice(0, 40)}”)`;
    const small = baseLen > 2000 && lr.body.length < baseLen * 0.25;
    const marker = lr.body.match(challengeMarkers);
    if (small && marker) return `pagină de verificare ${marker[1]} (${kb(lr.body.length)} față de ${kb(baseLen)} în browser)`;
    return undefined;
  };
  for (const b of BOTS) {
    const r = robots ? isAllowed(robots, b.token, '/') : { allowed: true };
    const lr = liveMap.get(b.token);
    const reason = lr ? blockReason(lr) : undefined;
    const blocked = lr ? !!reason : undefined;
    bots.push({
      token: b.token,
      operator: b.operator,
      purpose: b.purpose,
      robotsAllowed: r.allowed,
      robotsLine: 'rule' in r && r.rule ? `linia ${r.rule.line}: ${r.rule.raw}` : undefined,
      liveStatus: lr?.status,
      liveBlocked: blocked,
      liveReason: reason,
      liveBytes: lr?.body.length,
    });
  }

  return {
    origin,
    home,
    homeFetch,
    pages,
    robots,
    robotsStatus: robotsRes.status,
    sitemapUrls: sm.urls,
    sitemapFound: sm.found,
    sitemapStatus: sm.status,
    sitemap: sm,
    llmsTxt,
    bots,
    notes,
  };
}
