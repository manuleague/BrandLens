// Profilarea automată a unui brand pornind de la site (ca onboarding-ul din Peec / Semrush / Moz):
// citim paginile cheie, extragem date reale (schema, contact, navigație) și, dacă există un LLM,
// îl rugăm să sintetizeze profilul: ce vinde, topicuri, persone, competitori, domeniu de acoperire.

import { crawlSite } from './crawler.ts';
import type { EngineConfig } from './engines.ts';
import { findSchemaNode } from './html.ts';
import { llmJson } from './llm.ts';
import type { Facts, Lang, Persona, Topic, Vertical } from './types.ts';
import { domainOf, normalize } from './util.ts';

export interface SiteProfile {
  brandName: string;
  aliases: string[];
  description: string;
  vertical: Vertical;
  scope: 'local' | 'national' | 'international';
  country: string;
  city?: string;
  category: string;
  categoryEn: string;
  topics: Topic[];
  personas: Persona[];
  usps: string[];
  competitors: { name: string; domain?: string; reason?: string }[];
  facts: Facts;
  languages: Lang[];
  source: 'ai' | 'rules';
  pagesRead: string[];
  costUsd: number;
  warning?: string;
}

const BIZ = ['Organization', 'LocalBusiness', 'Restaurant', 'Store', 'OnlineStore', 'Corporation', 'ProfessionalService', 'FoodEstablishment'];

function firstSegment(title: string): string {
  return title.split(/\s[|–—\-:•]\s/)[0].trim();
}

/** Profil determinist din HTML (fără LLM): nume, descriere, contact, topicuri din navigație, tip de business. */
export function rulesProfile(domain: string, pages: { url: string; title: string; meta: string; h1: string[]; text: string; links: { href: string; text: string }[]; jsonLd: unknown[]; tel: string[] }[]): Omit<SiteProfile, 'source' | 'pagesRead' | 'costUsd'> {
  const home = pages[0];
  let org: Record<string, any> | null = null;
  for (const p of pages) {
    org = findSchemaNode(p.jsonLd, BIZ);
    if (org) break;
  }
  const ogName = home?.title ? firstSegment(home.title) : '';
  const brandName = (typeof org?.name === 'string' && org.name) || ogName || domainOf(domain).split('.')[0];
  const all = pages.map((p) => p.text).join('\n');
  const n = normalize(all);
  const ecommerce = /(adauga in cos|add to cart|cosul meu|cos de cumparaturi|checkout|livrare gratuita|stoc|in stoc)/.test(n);
  const restaurant = /(meniu|menu)/.test(n) && /(rezerv|livrare|comanda)/.test(n) && /(pizza|restaurant|bucatarie|preparate|desert|bistro|cafenea)/.test(n);
  const b2b = /(solicita (o )?oferta|request a demo|programeaza (un )?demo|pentru companii|enterprise|saas|b2b|clienti corporate)/.test(n);
  const vertical: Vertical = restaurant ? 'restaurant' : ecommerce ? 'ecommerce' : b2b ? 'b2b' : 'generic';
  // Topicuri: textele linkurilor de navigație de pe homepage care duc la secțiuni de prim nivel.
  const navTopics = new Map<string, number>();
  for (const l of home?.links ?? []) {
    const t = l.text.replace(/\s+/g, ' ').trim();
    if (t.length < 3 || t.length > 40 || /^(acasa|acasă|home|contact|login|cont|cos|coș|blog|despre|about|termeni|politic|cookies|ajutor|help|\d)/i.test(t)) continue;
    try {
      const u = new URL(l.href, home.url);
      if (domainOf(u.hostname) !== domainOf(domain)) continue;
      const depth = u.pathname.split('/').filter(Boolean).length;
      if (depth < 1 || depth > 2) continue;
    } catch {
      continue;
    }
    navTopics.set(t, (navTopics.get(t) ?? 0) + 1);
  }
  const topics = [...navTopics.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([name]) => ({ name }));
  const addr = org?.address;
  const facts: Facts = {
    phone: (typeof org?.telephone === 'string' && org.telephone) || home?.tel[0] || all.match(/(\+?40[\s.-]?\d{3}[\s.-]?\d{3}[\s.-]?\d{3}|0\d{3}[\s.-]?\d{3}[\s.-]?\d{3})/)?.[1],
    email: (typeof org?.email === 'string' && org.email) || all.match(/[\w.+-]+@[\w-]+\.[\w.]+/)?.[0],
    address: typeof addr === 'object' && addr ? [addr.streetAddress, addr.addressLocality].filter(Boolean).join(', ') : typeof addr === 'string' ? addr : undefined,
    city: typeof addr === 'object' && addr?.addressLocality ? String(addr.addressLocality) : undefined,
    description: (typeof org?.description === 'string' && org.description) || home?.meta || undefined,
    profiles: Array.isArray(org?.sameAs) ? org!.sameAs.filter((x: unknown) => typeof x === 'string') : undefined,
  };
  return {
    brandName,
    aliases: [],
    description: home?.meta || '',
    vertical,
    scope: vertical === 'restaurant' ? 'local' : 'national',
    country: domain.endsWith('.ro') ? 'RO' : 'RO',
    city: facts.city,
    category: '',
    categoryEn: '',
    topics,
    personas: [],
    usps: [],
    competitors: [],
    facts,
    languages: ['ro'],
  };
}

export async function profileSite(domain: string, cfg: EngineConfig, opts: { maxPages?: number } = {}): Promise<SiteProfile> {
  const crawl = await crawlSite(domain, { maxPages: opts.maxPages ?? 10, liveBotTest: false });
  const pages = crawl.pages
    .filter((p) => p.status >= 200 && p.status < 300)
    .map((p) => ({ url: p.url, title: p.parsed.title, meta: p.parsed.metaDescription, h1: p.parsed.h1, h2: p.parsed.h2.slice(0, 10), text: p.parsed.text, links: p.parsed.links, jsonLd: p.parsed.jsonLd, tel: p.parsed.telLinks }));
  const base = rulesProfile(domain, pages);
  const pagesRead = pages.map((p) => p.url);
  if (!pages.length) return { ...base, source: 'rules', pagesRead, costUsd: 0, warning: `Site-ul nu a putut fi citit (${crawl.homeFetch.error ?? 'status ' + crawl.homeFetch.status}).` };

  const digest = pages
    .slice(0, 10)
    .map((p) => `URL: ${p.url}\nTITLE: ${p.title}\nMETA: ${p.meta}\nH1: ${p.h1.join(' | ')}\nH2: ${p.h2.join(' | ')}\nTEXT: ${p.text.split(/\s+/).slice(0, 160).join(' ')}`)
    .join('\n---\n')
    .slice(0, 16000);
  const prompt = `Analyze this website and build a brand profile for AI-search (GEO) monitoring.
Domain: ${domainOf(domain)}
Structured data found: ${JSON.stringify({ name: base.brandName, ...base.facts }).slice(0, 800)}

PAGES:
${digest}

Return JSON with exactly these keys:
{
 "brandName": string, "aliases": string[] (other ways people write the brand, e.g. without diacritics or TLD),
 "description": string (1-2 factual sentences, Romanian),
 "vertical": "restaurant"|"local_service"|"ecommerce"|"b2b"|"generic",
 "scope": "local"|"national"|"international" (local only if customers must be physically near),
 "country": ISO-2, "city": string|null (only if scope is local),
 "category": string (Romanian, singular noun phrase a customer would use, e.g. "magazin online de electronice"),
 "categoryEn": string,
 "topics": [{"name": string (Romanian, 1-4 words), "description": string}] (5-8 product/service areas customers ask AI about),
 "personas": [{"name": string, "description": string (first person Romanian, how this buyer would describe themselves, 1 sentence)}] (3 distinct buyer types),
 "usps": string[] (max 5, only what the site states),
 "competitors": [{"name": string, "domain": string|null, "reason": string}] (5-8 real competitors in the same country/market that customers compare with; only brands you are confident exist),
 "facts": {"phone": string|null, "email": string|null, "address": string|null, "hours": string|null, "priceRange": string|null}
}
Use only information supported by the pages for description, usps and facts. Do not invent facts.`;
  const { data, usage } = await llmJson<Partial<SiteProfile> & { facts?: Record<string, string | null> }>(prompt, cfg, { maxTokens: 3000 });
  if (!data) return { ...base, source: 'rules', pagesRead, costUsd: usage.costUsd, warning: usage.error ? `Analiza AI nu a rulat: ${usage.error}` : 'Analiza AI nu a întors un răspuns valid; am folosit doar datele din HTML.' };
  const str = (x: unknown) => (typeof x === 'string' && x.trim() ? x.trim() : undefined);
  const verticals: Vertical[] = ['restaurant', 'local_service', 'ecommerce', 'b2b', 'generic'];
  return {
    brandName: str(data.brandName) ?? base.brandName,
    aliases: Array.isArray(data.aliases) ? data.aliases.filter((a): a is string => typeof a === 'string').slice(0, 6) : [],
    description: str(data.description) ?? base.description,
    vertical: verticals.includes(data.vertical as Vertical) ? (data.vertical as Vertical) : base.vertical,
    scope: data.scope === 'local' || data.scope === 'international' ? data.scope : 'national',
    country: str(data.country)?.toUpperCase().slice(0, 2) ?? 'RO',
    city: data.scope === 'local' ? str(data.city) ?? base.city : undefined,
    category: str(data.category) ?? '',
    categoryEn: str(data.categoryEn) ?? '',
    topics: (Array.isArray(data.topics) ? data.topics : []).filter((t) => t && str(t.name)).slice(0, 10).map((t) => ({ name: t.name.trim(), description: str(t.description) })),
    personas: (Array.isArray(data.personas) ? data.personas : []).filter((t) => t && str(t.name) && str(t.description)).slice(0, 5).map((t) => ({ name: t.name.trim(), description: t.description.trim() })),
    usps: Array.isArray(data.usps) ? data.usps.filter((u): u is string => typeof u === 'string').slice(0, 5) : [],
    competitors: (Array.isArray(data.competitors) ? data.competitors : [])
      .filter((c) => c && str(c.name) && normalize(c.name) !== normalize(base.brandName))
      .slice(0, 10)
      .map((c) => ({ name: c.name.trim(), domain: str(c.domain) ? domainOf(c.domain!) : undefined, reason: str(c.reason) })),
    facts: {
      ...base.facts,
      ...Object.fromEntries(Object.entries(data.facts ?? {}).filter(([, v]) => typeof v === 'string' && v.trim()).map(([k, v]) => [k, (v as string).trim()])),
    },
    languages: ['ro'],
    source: 'ai',
    pagesRead,
    costUsd: usage.costUsd,
  };
}
