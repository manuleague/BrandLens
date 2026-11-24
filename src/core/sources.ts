// Source tracer: ce domenii citează AI-ul pentru prompturile tale, ce tip sunt și unde câștigă competitorii.
// Echivalentul „backlink-urilor pentru AI”.

import type { Project, StoredResult } from './types.ts';
import { normalize, sameSite } from './util.ts';

export type SourceType = 'owned' | 'competitor' | 'brand' | 'maps' | 'directory' | 'review' | 'comparison' | 'delivery' | 'ugc' | 'social' | 'news' | 'marketplace' | 'reference' | 'authority' | 'editorial';

/** Grupele folosite de GEOflux în „State of AI”: site-uri de brand, marketplace-uri, media, comparație/review, comunitate, autoritate. */
export type SourceGroup = 'brand_sites' | 'marketplaces' | 'media' | 'comparison_review' | 'community' | 'authority' | 'other';
export const SOURCE_GROUP_LABEL: Record<SourceGroup, string> = {
  brand_sites: 'Site-uri de brand și produs',
  marketplaces: 'Marketplace-uri',
  media: 'Media și bloguri',
  comparison_review: 'Comparație, review, directoare',
  community: 'Comunitate și social',
  authority: 'Autoritate și referință',
  other: 'Altele',
};
export const GROUP_OF: Record<SourceType, SourceGroup> = {
  owned: 'brand_sites', competitor: 'brand_sites', brand: 'brand_sites', delivery: 'marketplaces', marketplace: 'marketplaces',
  news: 'media', editorial: 'media', review: 'comparison_review', comparison: 'comparison_review', directory: 'comparison_review', maps: 'comparison_review',
  ugc: 'community', social: 'community', reference: 'authority', authority: 'authority',
};

export const SOURCE_TYPE_LABEL: Record<SourceType, string> = {
  owned: 'Site propriu',
  competitor: 'Site competitor',
  brand: 'Site de brand (alt brand)',
  comparison: 'Comparator de prețuri',
  authority: 'Instituție / autoritate',
  maps: 'Hărți',
  directory: 'Director / listări',
  review: 'Platformă de recenzii',
  delivery: 'Platformă de livrare',
  ugc: 'Forum / comunitate',
  social: 'Social media',
  news: 'Presă',
  marketplace: 'Marketplace',
  reference: 'Enciclopedie / bază de date',
  editorial: 'Blog / articol / listă',
};

const RULES: [RegExp, SourceType][] = [
  [/(maps\.google|google\.[a-z.]+\/maps|^google\.[a-z.]+$|maps\.apple|waze|^bing\.com$)/, 'maps'],
  [/(tripadvisor|yelp|foursquare|restaurantguru|zomato|thefork|opentable|paginiaurii|cylex|firmepenet|listafirme|romania-insider\.com\/directory|top-?rated|wanderlog)/, 'directory'],
  [/(trustpilot|g2\.com|capterra|getapp|softwareadvice|clutch\.co|glassdoor|reviews\.io|recenzii)/, 'review'],
  [/(glovo|tazz|bolt\.eu|foodpanda|ubereats|wolt|deliveroo|takeaway|food\.bolt)/, 'delivery'],
  [/(reddit|quora|forum|softpedia\.ro\/forum|stackexchange|stackoverflow|tpu\.ro)/, 'ugc'],
  [/(facebook|instagram|tiktok|youtube|linkedin|x\.com|twitter|pinterest|threads)/, 'social'],
  [/(hotnews|digi24|adevarul|ziaruldeiasi|bzi\.ro|stirileprotv|wall-street\.ro|ziare\.com|agerpres|g4media|libertatea|observatornews|mediafax|profit\.ro|economica|zf\.ro|news\.ro|iasi\.tv|iasifun|7est|romania-insider|euronews|bbc|reuters|cnn|nytimes|forbes|startupcafe|capital\.ro|playtech|republica\.ro)/, 'news'],
  [/(emag|olx|altex|amazon|ebay|cel\.ro|pcgarage|elefant|notino|fashiondays|aliexpress|etsy|temu)/, 'marketplace'],
  [/(compari\.ro|shopmania|price\.ro|pricerunner|idealo|kelkoo|ceneo|heureka|pricespy|bestprice)/, 'comparison'],
  [/(\.gov(\.[a-z]{2})?$|gov\.ro$|\.edu(\.[a-z]{2})?$|anpc\.ro|europa\.eu|onrc\.ro|anaf\.ro|bnr\.ro|asf\.ro|ins\.ro)/, 'authority'],
  [/(wikipedia|wikidata|crunchbase|britannica|termene\.ro|risco\.ro|listafirme)/, 'reference'],
];

export function classifyDomain(domain: string, p: Project, brandNames: string[] = []): SourceType {
  if (sameSite(domain, p.domain)) return 'owned';
  if (p.competitors.some((c) => c.domain && sameSite(domain, c.domain))) return 'competitor';
  for (const [re, t] of RULES) if (re.test(domain)) return t;
  // Domeniu care conține numele unui brand numit în răspunsuri (ex. altex.ro pentru „Altex”) → site de brand.
  const label = normalize(domain.split('.').slice(0, -1).join('')).replace(/[^a-z0-9]/g, '');
  if (label.length >= 3 && brandNames.some((b) => {
    const nb = normalize(b).replace(/[^a-z0-9]/g, '');
    return nb.length >= 3 && (label === nb || label.startsWith(nb) || nb.startsWith(label));
  })) return 'brand';
  return 'editorial';
}

export interface SourceRow {
  domain: string;
  type: SourceType;
  group: SourceGroup;
  citations: number; // de câte ori apare în răspunsuri
  answers: number;
  share: number; // din totalul răspunsurilor cu citări
  withOwn: number; // răspunsuri în care apare și brandul tău
  withCompetitors: number; // răspunsuri în care apar competitori, dar nu tu
  gapScore: number; // 0..100 — frecvență × (competitori fără tine)
  urls: { url: string; title?: string; count: number }[];
  engines: string[];
}

export function analyzeSources(results: StoredResult[], p: Project): { rows: SourceRow[]; answersWithCitations: number; ownShare: number; typeShare: Record<string, number>; groupShare: Record<string, number> } {
  const valid = results.filter((r) => !r.error);
  const brandNames = [...new Set(valid.flatMap((r) => (r.extraction.brands ?? []).map((b) => b.name).concat(r.extraction.discovered ?? [])))];
  const withCits = valid.filter((r) => r.citations.length);
  const map = new Map<string, SourceRow & { _answers: Set<string>; _urls: Map<string, { url: string; title?: string; count: number }>; _eng: Set<string> }>();
  for (const r of withCits) {
    const domainsInAnswer = new Set<string>();
    for (const c of r.citations) {
      if (c.kind !== 'cited') continue;
      const d = c.domain;
      const row =
        map.get(d) ??
        { domain: d, type: classifyDomain(d, p, brandNames), group: 'other' as SourceGroup, citations: 0, answers: 0, share: 0, withOwn: 0, withCompetitors: 0, gapScore: 0, urls: [], engines: [], _answers: new Set(), _urls: new Map(), _eng: new Set() };
      row.citations++;
      row._eng.add(r.engine);
      const u = row._urls.get(c.url) ?? { url: c.url, title: c.title, count: 0 };
      u.count++;
      row._urls.set(c.url, u);
      map.set(d, row);
      domainsInAnswer.add(d);
    }
    for (const d of domainsInAnswer) {
      const row = map.get(d)!;
      if (row._answers.has(r.id)) continue;
      row._answers.add(r.id);
      row.answers++;
      if (r.extraction.ownMentioned) row.withOwn++;
      else if (r.extraction.mentions.some((m) => !m.own) || r.extraction.discovered.length) row.withCompetitors++;
    }
  }
  const total = withCits.length || 1;
  const rows = [...map.values()].map(({ _answers, _urls, _eng, ...row }) => {
    const share = row.answers / total;
    const compRatio = row.answers ? row.withCompetitors / row.answers : 0;
    const ownRatio = row.answers ? row.withOwn / row.answers : 0;
    const gap = ['owned', 'competitor', 'brand'].includes(row.type) ? 0 : Math.round(100 * Math.min(1, share * 4) * Math.max(0, compRatio - ownRatio * 0.5));
    return { ...row, group: GROUP_OF[row.type] ?? 'other', share, gapScore: gap, urls: [..._urls.values()].sort((a, b) => b.count - a.count).slice(0, 10), engines: [..._eng] };
  });
  rows.sort((a, b) => b.answers - a.answers);
  const typeShare: Record<string, number> = {};
  const cTotal = rows.reduce((s, r) => s + r.citations, 0) || 1;
  rows.forEach((r) => (typeShare[r.type] = (typeShare[r.type] ?? 0) + r.citations / cTotal));
  const groupShare: Record<string, number> = {};
  rows.forEach((r) => (groupShare[r.group] = (groupShare[r.group] ?? 0) + r.citations / cTotal));
  const own = rows.filter((r) => r.type === 'owned').reduce((s, r) => s + r.answers, 0);
  return { rows, answersWithCitations: withCits.length, ownShare: own / total, typeShare, groupShare };
}
