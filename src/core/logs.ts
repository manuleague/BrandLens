// Analiza logurilor de acces pentru crawlerele AI (echivalentul „Agent Analytics” din Profound):
// câte vizite fac boții AI, pe ce pagini, cu ce coduri de răspuns, plus traficul uman venit din asistenții AI.
// Formate: Apache/Nginx combined, IIS W3C (#Fields), Cloudflare/JSON lines.

import { AI_REFERRER_REGEX, BOTS } from './bots.ts';

const EXTRA_BOTS: { token: string; operator: string; purpose: 'search' | 'user' | 'training' }[] = [
  { token: 'Amazonbot', operator: 'Amazon', purpose: 'training' },
  { token: 'Bytespider', operator: 'ByteDance', purpose: 'training' },
  { token: 'cohere-ai', operator: 'Cohere', purpose: 'training' },
  { token: 'YouBot', operator: 'You.com', purpose: 'search' },
  { token: 'MistralAI-User', operator: 'Mistral', purpose: 'user' },
  { token: 'Google-CloudVertexBot', operator: 'Google', purpose: 'user' },
  { token: 'Diffbot', operator: 'Diffbot', purpose: 'training' },
  { token: 'TikTokSpider', operator: 'ByteDance', purpose: 'training' },
  { token: 'Timpibot', operator: 'Timpi', purpose: 'training' },
];
const ALL = [...BOTS.map((b) => ({ token: b.token, operator: b.operator, purpose: b.purpose })), ...EXTRA_BOTS];
// Ordonare: tokenurile mai lungi întâi (ex. „Claude-SearchBot” înaintea lui „ClaudeBot”, „Applebot-Extended” înaintea „Applebot”).
const MATCHERS = ALL.map((b) => ({ ...b, re: new RegExp(b.token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') })).sort((a, b) => b.token.length - a.token.length);
const AI_REF = new RegExp(AI_REFERRER_REGEX, 'i');

export interface LogLine {
  ts: string; // YYYY-MM-DD
  path: string;
  status: number;
  ua: string;
  referer: string;
}

export interface LogReport {
  format: string;
  lines: number;
  parsed: number;
  from: string | null;
  to: string | null;
  bots: { token: string; operator: string; purpose: string; hits: number; pages: number; blocked: number; statuses: Record<string, number>; topPaths: { path: string; hits: number }[] }[];
  byDay: { date: string; bot: string; hits: number }[];
  aiReferrals: { source: string; visits: number; topLanding: { path: string; visits: number }[] }[];
  topPagesAllBots: { path: string; hits: number }[];
  notCrawled: string[]; // pagini importante (din sitemap/crawl) nevizitate de niciun bot de căutare AI
}

const MONTHS: Record<string, string> = { Jan: '01', Feb: '02', Mar: '03', Apr: '04', May: '05', Jun: '06', Jul: '07', Aug: '08', Sep: '09', Oct: '10', Nov: '11', Dec: '12' };

export class LogAnalyzer {
  private format = 'necunoscut';
  private fields: string[] | null = null;
  lines = 0;
  parsed = 0;
  private bots = new Map<string, { token: string; operator: string; purpose: string; hits: number; paths: Map<string, number>; statuses: Map<string, number>; blocked: number }>();
  private days = new Map<string, number>();
  private refs = new Map<string, { visits: number; landing: Map<string, number> }>();
  private allPaths = new Map<string, number>();
  private from: string | null = null;
  private to: string | null = null;

  push(raw: string): void {
    const line = raw.trim();
    if (!line) return;
    if (line.startsWith('#')) {
      if (line.startsWith('#Fields:')) {
        this.fields = line.slice(8).trim().split(/\s+/);
        this.format = 'IIS W3C';
      }
      return;
    }
    this.lines++;
    const l = this.parse(line);
    if (!l) return;
    this.parsed++;
    if (!this.from || l.ts < this.from) this.from = l.ts;
    if (!this.to || l.ts > this.to) this.to = l.ts;
    const path = l.path.split('?')[0] || '/';
    const bot = MATCHERS.find((m) => m.re.test(l.ua));
    if (bot) {
      const b = this.bots.get(bot.token) ?? { token: bot.token, operator: bot.operator, purpose: bot.purpose, hits: 0, paths: new Map(), statuses: new Map(), blocked: 0 };
      b.hits++;
      b.paths.set(path, (b.paths.get(path) ?? 0) + 1);
      b.statuses.set(String(l.status), (b.statuses.get(String(l.status)) ?? 0) + 1);
      if ([401, 403, 429, 503].includes(l.status)) b.blocked++;
      this.bots.set(bot.token, b);
      this.days.set(`${l.ts}|${bot.token}`, (this.days.get(`${l.ts}|${bot.token}`) ?? 0) + 1);
      this.allPaths.set(path, (this.allPaths.get(path) ?? 0) + 1);
      return;
    }
    if (l.referer && AI_REF.test(l.referer)) {
      let src = 'alt asistent AI';
      try {
        src = new URL(l.referer).hostname.replace(/^www\./, '');
      } catch {
        /* referer invalid */
      }
      const r = this.refs.get(src) ?? { visits: 0, landing: new Map() };
      r.visits++;
      r.landing.set(path, (r.landing.get(path) ?? 0) + 1);
      this.refs.set(src, r);
    }
  }

  private parse(line: string): LogLine | null {
    // JSON lines (Cloudflare Logpush etc.)
    if (line.startsWith('{')) {
      try {
        const j = JSON.parse(line);
        this.format = 'JSON';
        const ts = String(j.EdgeStartTimestamp ?? j.timestamp ?? j.time ?? j['@timestamp'] ?? '');
        const date = /^\d+$/.test(ts) ? new Date(Number(ts) / (ts.length > 13 ? 1e6 : 1)).toISOString().slice(0, 10) : ts.slice(0, 10);
        return { ts: date, path: String(j.ClientRequestURI ?? j.ClientRequestPath ?? j.path ?? j.request_uri ?? '/'), status: Number(j.EdgeResponseStatus ?? j.OriginResponseStatus ?? j.status ?? 0), ua: String(j.ClientRequestUserAgent ?? j.user_agent ?? j.http_user_agent ?? ''), referer: String(j.ClientRequestReferer ?? j.referer ?? j.http_referer ?? '') };
      } catch {
        return null;
      }
    }
    // IIS W3C
    if (this.fields) {
      const parts = line.split(' ');
      const f = (name: string) => {
        const i = this.fields!.indexOf(name);
        return i >= 0 ? parts[i] ?? '' : '';
      };
      const ua = f('cs(User-Agent)').replace(/\+/g, ' ');
      return { ts: f('date'), path: f('cs-uri-stem') || '/', status: Number(f('sc-status')) || 0, ua, referer: f('cs(Referer)') === '-' ? '' : f('cs(Referer)') };
    }
    // Apache/Nginx combined
    const m = line.match(/^\S+ \S+ \S+ \[(\d{2})\/(\w{3})\/(\d{4}):[^\]]+\] "(?:[A-Z]+ )?([^ "]*)[^"]*" (\d{3}) \S+(?: "([^"]*)" "([^"]*)")?/);
    if (m) {
      this.format = 'Apache/Nginx combined';
      return { ts: `${m[3]}-${MONTHS[m[2]] ?? '01'}-${m[1]}`, path: m[4] || '/', status: Number(m[5]), referer: m[6] && m[6] !== '-' ? m[6] : '', ua: m[7] ?? '' };
    }
    return null;
  }

  report(importantPaths: string[] = []): LogReport {
    const bots = [...this.bots.values()].sort((a, b) => b.hits - a.hits).map((b) => ({
      token: b.token,
      operator: b.operator,
      purpose: b.purpose,
      hits: b.hits,
      pages: b.paths.size,
      blocked: b.blocked,
      statuses: Object.fromEntries(b.statuses),
      topPaths: [...b.paths.entries()].sort((x, y) => y[1] - x[1]).slice(0, 15).map(([path, hits]) => ({ path, hits })),
    }));
    const searchBotPaths = new Set([...this.bots.values()].filter((b) => b.purpose !== 'training').flatMap((b) => [...b.paths.keys()]));
    return {
      format: this.format,
      lines: this.lines,
      parsed: this.parsed,
      from: this.from,
      to: this.to,
      bots,
      byDay: [...this.days.entries()].map(([k, hits]) => ({ date: k.split('|')[0], bot: k.split('|')[1], hits })).sort((a, b) => a.date.localeCompare(b.date)),
      aiReferrals: [...this.refs.entries()].sort((a, b) => b[1].visits - a[1].visits).map(([source, r]) => ({ source, visits: r.visits, topLanding: [...r.landing.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([path, visits]) => ({ path, visits })) })),
      topPagesAllBots: [...this.allPaths.entries()].sort((a, b) => b[1] - a[1]).slice(0, 25).map(([path, hits]) => ({ path, hits })),
      notCrawled: importantPaths.filter((p) => !searchBotPaths.has(p)).slice(0, 30),
    };
  }
}
