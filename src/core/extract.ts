// Extracția din răspunsurile AI: mențiuni (ordine), recomandare, sentiment, citări proprii,
// entități descoperite (pe cine alege AI-ul în locul tău) și verificarea acurateței datelor.
// Determinist și explicabil; opțional rafinat cu LLM-as-judge (vezi judge()).

import { complete, type EngineConfig } from './engines.ts';
import { llmJson } from './llm.ts';
import type { AccuracyIssue, BrandHit, Citation, Extraction, Mention, Project } from './types.ts';
import { escapeRegExp, normalize, phoneKey, sameSite } from './util.ts';

const POS = ['recomand', 'cea mai buna', 'cel mai bun', 'cele mai bune', 'excelent', 'delicios', 'apreciat', 'popular', 'autentic', 'de calitate', 'calitate buna', 'prietenos', 'rapid', 'merita', 'favorit', 'top', 'laudat', 'best', 'excellent', 'great', 'highly rated', 'popular', 'recommended', 'authentic', 'delicious', 'friendly', 'top-rated', 'standout', 'must-try', 'loved', 'reliable'];
const NEG = ['slab', 'scump', 'lent', 'intarziere', 'intarzieri', 'nemultumit', 'plangeri', 'reclamatii', 'dezamagit', 'murdar', 'nepoliticos', 'evita', 'inchis definitiv', 'mixed', 'poor', 'expensive', 'slow', 'complaints', 'disappointing', 'rude', 'avoid', 'overpriced', 'permanently closed', 'inconsistent'];
const RECO = ['recomand', 'iti recomand', 'va recomand', 'cea mai buna', 'cel mai bun', 'top', 'alegere', 'merita', 'optiune buna', 'excelenta', 'recommend', 'best', 'top pick', 'go-to', 'great choice', 'worth', 'standout'];
const REFUSAL = /(nu am acces la informatii in timp real|nu pot naviga|i (can't|cannot) browse|i don't have (real-time|access)|nu pot oferi recomandari|as an ai)/i;

interface BrandDef {
  name: string;
  own: boolean;
  needles: string[];
  domain?: string;
}

export function brandDefs(p: Project): BrandDef[] {
  const own: BrandDef = { name: p.name, own: true, needles: uniq([p.name, ...p.aliases]), domain: p.domain };
  return [own, ...p.competitors.map((c) => ({ name: c.name, own: false, needles: uniq([c.name, ...(c.aliases ?? [])]), domain: c.domain }))];
}

function uniq(a: string[]): string[] {
  return [...new Set(a.map((x) => x.trim()).filter((x) => x.length >= 2))];
}

function firstIndex(normText: string, needles: string[]): number {
  let best = -1;
  for (const n of needles) {
    const nn = normalize(n);
    const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(nn)}($|[^a-z0-9])`, 'i');
    const m = re.exec(normText);
    if (m) {
      const idx = m.index + m[1].length;
      if (best === -1 || idx < best) best = idx;
    }
  }
  return best;
}

/** Fraza / elementul de listă în care apare o poziție din text. */
function segmentAt(text: string, idx: number): string {
  const startCands = [text.lastIndexOf('\n', idx), text.lastIndexOf('. ', idx), text.lastIndexOf('! ', idx), text.lastIndexOf('? ', idx)];
  const start = Math.max(...startCands) + 1;
  const ends = ['\n', '. ', '! ', '? '].map((s) => text.indexOf(s, idx)).filter((x) => x >= 0);
  // Pentru elemente de listă păstrăm și descrierea de pe rândurile următoare (până la următorul element).
  let end = ends.length ? Math.min(...ends) : text.length;
  const nextItem = text.slice(idx).search(/\n\s*(\d+[.)]|[-*•])\s/);
  const nl = text.indexOf('\n', idx);
  if (nl >= 0 && nl === end && nextItem > 0) end = Math.min(idx + nextItem, idx + 600);
  return text.slice(Math.max(0, start), end).trim();
}

function sentimentOf(seg: string): number {
  const n = normalize(seg);
  let s = 0;
  POS.forEach((w) => n.includes(w) && (s += 1));
  NEG.forEach((w) => n.includes(w) && (s -= 1.5));
  return Math.max(0, Math.min(10, 6 + s * 1.2));
}

/** Nume numite în liste numerotate / bold — pentru a descoperi competitori neurmăriți. */
export function discoverEntities(text: string): string[] {
  const out: string[] = [];
  const add = (s: string) => {
    const t = s.replace(/\[[^\]]*\]\([^)]*\)/g, '').replace(/[*_`#]/g, '').replace(/\s+/g, ' ').trim().replace(/[:–—-]+$/, '').trim();
    if (t.length >= 3 && t.length <= 48 && /[A-ZĂÂÎȘȚ]/.test(t[0]) && t.split(' ').length <= 6 && !/^(Pre[tț]|Program|Adres|Telefon|Livrare|Recenzii|Rating|Price|Address|Hours|Why|De ce|Note|Notă|Concluzie|Sfat|Tips?|Atmosfer|Meniu|Menu|Specialit|Location|Locație|Website|Sursa|Source)/i.test(t)) out.push(t);
  };
  for (const m of text.matchAll(/^\s*(?:\d+[.)]|[-*•])\s+\**([^*:\n(–—|]{2,60})/gm)) add(m[1]);
  for (const m of text.matchAll(/\*\*([^*\n]{2,60})\*\*/g)) add(m[1]);
  for (const m of text.matchAll(/^#{2,4}\s+(?:\d+[.)]\s*)?([^\n]{2,60})$/gm)) add(m[1]);
  return [...new Set(out)];
}

function checkAccuracy(text: string, p: Project, ownIdx: number): AccuracyIssue[] {
  if (ownIdx < 0) return [];
  const issues: AccuracyIssue[] = [];
  const seg = segmentAt(text, ownIdx) + ' ' + text.slice(ownIdx, ownIdx + 500);
  if (p.facts.phone) {
    const want = phoneKey(p.facts.phone);
    for (const m of seg.matchAll(/(\+?4?0[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/g)) {
      const k = phoneKey(m[1]);
      if (k.length === 9 && k !== want) issues.push({ field: 'phone', expected: p.facts.phone, found: m[1], snippet: seg.slice(0, 220) });
    }
  }
  if (p.facts.address) {
    const am = seg.match(/\b(str\.?|strada|bd\.?|bulevardul|calea|șos\.?|soseaua|piața|piata)\s+([A-ZĂÂÎȘȚa-zăâîșț. -]{3,40}?)(,|\s+nr|\s+\d)/i);
    if (am) {
      const found = normalize(am[2]).split(/\s+/).filter((w) => w.length > 3);
      const want = normalize(p.facts.address);
      if (found.length && !found.some((w) => want.includes(w))) issues.push({ field: 'address', expected: p.facts.address, found: am[0], snippet: seg.slice(0, 220) });
    }
  }
  return issues;
}

export function extract(text: string, citations: Citation[], p: Project): Extraction {
  const norm = normalize(text);
  const defs = brandDefs(p);
  const found: { def: BrandDef; idx: number }[] = [];
  for (const d of defs) {
    const idx = firstIndex(norm, d.needles);
    if (idx >= 0) found.push({ def: d, idx });
  }
  // Entitățile descoperite intră în ordonare ca să calculăm poziția reală în listă.
  const trackedNorm = defs.flatMap((d) => d.needles.map(normalize));
  const discovered = discoverEntities(text).filter((e) => {
    const ne = normalize(e);
    return !trackedNorm.some((t) => ne.includes(t) || t.includes(ne));
  });
  const discIdx = discovered.map((e) => ({ e, idx: norm.indexOf(normalize(e)) })).filter((x) => x.idx >= 0);
  const order = [...found.map((f) => ({ key: f.def.name, idx: f.idx })), ...discIdx.map((d) => ({ key: d.e, idx: d.idx }))].sort((a, b) => a.idx - b.idx);
  const posOf = (k: string) => order.findIndex((o) => o.key === k) + 1;

  const mentions: Mention[] = found
    .sort((a, b) => a.idx - b.idx)
    .map(({ def, idx }) => {
      const seg = segmentAt(text, idx);
      const nseg = normalize(seg);
      const position = posOf(def.name);
      const inList = /^\s*(\d+[.)]|[-*•]|#{2,4})/.test(seg) || /\n\s*(\d+[.)]|[-*•])\s+[^\n]*$/.test(text.slice(Math.max(0, idx - 120), idx + 1));
      const sentiment = sentimentOf(seg);
      const negative = NEG.some((w) => nseg.includes(w));
      const recommended = !negative && (RECO.some((w) => nseg.includes(w)) || (inList && position <= 3) || (inList && sentiment >= 7));
      return { brand: def.name, own: def.own, tracked: true, position, recommended, sentiment, snippet: seg.slice(0, 280) };
    });

  const own = mentions.find((m) => m.own);
  const ownCited = citations.some((c) => c.kind === 'cited' && sameSite(c.domain, p.domain));
  const ownIdx = own ? found.find((f) => f.def.own)!.idx : -1;
  // Toate brandurile numite (urmărite + descoperite), cu atributele găsite lângă ele.
  const brands: BrandHit[] = order.map((o, i) => {
    const m = mentions.find((x) => x.brand === o.key);
    const seg = m?.snippet ?? segmentAt(text, o.idx);
    return { name: o.key, own: !!m?.own, tracked: !!m, position: i + 1, recommended: m ? m.recommended : i < 3, sentiment: m ? m.sentiment : sentimentOf(seg), attributes: attributesOf(seg) };
  });
  return {
    brands,
    analysis: 'rules',
    mentions,
    ownMentioned: !!own,
    ownCited,
    ownPosition: own ? own.position : null,
    ownRecommended: !!own?.recommended,
    ownSentiment: own ? own.sentiment : null,
    discovered,
    ranked: order.map((o) => o.key),
    accuracy: checkAccuracy(text, p, ownIdx),
    refusal: REFUSAL.test(norm) && text.length < 600,
  };
}

const ATTR_POS: [RegExp, string][] = [
  [/pret(uri)? (mic|bun|accesibil|competitiv)|ieftin|accesibil|cheap|affordable|good value|raport calitate-pret/, 'prețuri bune'],
  [/livrare (rapida|gratuita|in aceeasi zi|express)|fast delivery|free delivery|same-day/, 'livrare rapidă'],
  [/gama (larga|variata|mare)|ofert[a] (larga|variata|mare)|selectie (larga|mare)|wide (range|selection)|large selection/, 'ofertă variată'],
  [/retur (usor|gratuit|simplu)|easy returns|free returns/, 'retur ușor'],
  [/(de )?incredere|reliable|trusted|reputable/, 'de încredere'],
  [/calitate (buna|ridicata|excelenta)|high quality|premium/, 'calitate'],
  [/recenzii (bune|excelente|pozitive)|bine (cotat|evaluat)|apreciat|highly rated|top-rated|well reviewed/, 'recenzii bune'],
  [/garantie|warranty/, 'garanție'],
  [/autentic|traditional|artizanal|authentic/, 'autentic'],
  [/delicios|gustos|delicious|tasty/, 'gust bun'],
  [/popular/, 'popular'],
];
const ATTR_NEG: [RegExp, string][] = [
  [/scump|pret(uri)? (mari|ridicate)|expensive|overpriced|pricey/, 'scump'],
  [/intarzier|livrare (lenta|intarziata)|slow delivery|delays?/, 'întârzieri la livrare'],
  [/plangeri|reclamatii|complaints|nemultumi/, 'reclamații'],
  [/suport (slab|lent)|poor (customer )?service|greu de contactat/, 'suport slab'],
  [/calitate (slaba|variabila|inconsecventa)|inconsistent|poor quality/, 'calitate inconsecventă'],
  [/timp(i)? de asteptare|wait(ing)? times?/, 'timp de așteptare'],
];

/** Atribute scurte (pozitive/negative) din fraza în care e numit brandul — ce „spune” AI-ul despre el. */
export function attributesOf(seg: string): BrandHit['attributes'] {
  const n = normalize(seg);
  const out: BrandHit['attributes'] = [];
  for (const [re, t] of ATTR_POS) if (re.test(n)) out.push({ text: t, polarity: 'pos' });
  for (const [re, t] of ATTR_NEG) if (re.test(n)) out.push({ text: t, polarity: 'neg' });
  return out.slice(0, 5);
}

/** Analiza completă cu LLM: toate brandurile numite, poziția, dacă e recomandat, tonul și ce se spune despre fiecare.
 *  Mențiunea brandului propriu rămâne verificată determinist (potrivire pe nume); LLM-ul nu o poate „inventa”. */
export async function analyzeWithLLM(text: string, ex: Extraction, p: Project, cfg: EngineConfig): Promise<{ extraction: Extraction; costUsd: number; error?: string }> {
  if (!text.trim() || ex.refusal) return { extraction: ex, costUsd: 0 };
  const prompt = `Analyze this answer from an AI assistant. A user asked a buying question; the answer may name companies, stores, product brands or services.

Tracked brand: "${p.name}" (aliases: ${p.aliases.join(', ') || 'none'})
Tracked competitors: ${p.competitors.map((c) => c.name).join(', ') || 'none'}

For EVERY company/brand the answer presents as an option or names when discussing options (ignore pure source/publication names unless recommended as an option), return in order of first appearance:
- name: the brand name as written (canonical form, no TLD)
- recommended: true if presented as a recommended/suggested option, false if only mentioned, criticized or dismissed
- sentiment: 0-10 tone toward that brand (5 neutral)
- attributes: up to 4 short phrases (2-4 words, in the answer's language) of what the answer says about it, each with polarity "pos"|"neg"|"neu"

Return JSON: {"brands":[{"name":string,"recommended":boolean,"sentiment":number,"attributes":[{"text":string,"polarity":"pos"|"neg"|"neu"}]}]}

ANSWER:
<<<
${text.slice(0, 9000)}
>>>`;
  const { data, usage } = await llmJson<{ brands: { name: string; recommended?: boolean; sentiment?: number; attributes?: { text: string; polarity?: string }[] }[] }>(prompt, cfg, { maxTokens: 1800 });
  if (!data?.brands) return { extraction: ex, costUsd: usage.costUsd, error: usage.error };
  const defs = brandDefs(p);
  const canon = (name: string): { name: string; own: boolean; tracked: boolean } => {
    const n = normalize(name).replace(/\.(ro|com|eu|net)$/, '');
    for (const d of defs)
      if (d.needles.some((x) => {
        const nx = normalize(x);
        return nx === n || (nx.length > 3 && n.includes(nx)) || (n.length > 3 && nx.includes(n));
      }))
        return { name: d.name, own: d.own, tracked: true };
    return { name: name.trim(), own: false, tracked: false };
  };
  const seen = new Set<string>();
  const brands: BrandHit[] = [];
  for (const b of data.brands) {
    if (!b?.name || typeof b.name !== 'string') continue;
    const c = canon(b.name);
    const key = normalize(c.name);
    if (seen.has(key)) continue;
    seen.add(key);
    brands.push({
      name: c.name,
      own: c.own,
      tracked: c.tracked,
      position: brands.length + 1,
      recommended: !!b.recommended,
      sentiment: Math.max(0, Math.min(10, Number(b.sentiment ?? 5))),
      attributes: (b.attributes ?? []).filter((a) => a && typeof a.text === 'string').slice(0, 4).map((a) => ({ text: a.text.trim(), polarity: a.polarity === 'pos' || a.polarity === 'neg' ? a.polarity : 'neu' })),
    });
  }
  // LLM-ul a numit brandul propriu, dar regula nu l-a găsit textual → nu acceptăm (evităm halucinații).
  for (const b of brands) if (b.own && !ex.ownMentioned) b.own = false;
  if (ex.ownMentioned && !brands.some((b) => b.own)) {
    const r = ex.brands?.find((b) => b.own);
    if (r) brands.splice(Math.min(brands.length, r.position - 1), 0, { ...r });
  }
  brands.forEach((b, i) => (b.position = i + 1));
  const ownHit = brands.find((b) => b.own);
  const mentions = ex.mentions.map((m) => {
    const h = brands.find((b) => b.name === m.brand);
    return h ? { ...m, position: h.position, recommended: h.recommended, sentiment: h.sentiment } : m;
  });
  return {
    extraction: {
      ...ex,
      brands,
      mentions,
      analysis: 'llm',
      ranked: brands.map((b) => b.name),
      discovered: brands.filter((b) => !b.tracked).map((b) => b.name),
      ownPosition: ownHit ? ownHit.position : ex.ownPosition,
      ownRecommended: ownHit ? ownHit.recommended : ex.ownRecommended,
      ownSentiment: ownHit ? ownHit.sentiment : ex.ownSentiment,
    },
    costUsd: usage.costUsd,
  };
}

/** LLM-as-judge opțional: rafinează recomandarea și sentimentul brandului propriu. Output JSON versionat. */
export async function judge(text: string, ex: Extraction, p: Project, cfg: EngineConfig): Promise<Extraction> {
  if (!ex.ownMentioned) return ex;
  const prompt = `Ești un evaluator strict. Analizează răspunsul unui asistent AI de mai jos și spune, DOAR despre brandul "${p.name}":
- recommended: true dacă răspunsul îl recomandă explicit sau îl include ca opțiune sugerată, false dacă doar îl menționează neutru/negativ
- sentiment: număr 0-10 (0 foarte negativ, 5 neutru, 10 foarte pozitiv)
Răspunde STRICT cu JSON: {"recommended":bool,"sentiment":number,"reason":"<max 20 cuvinte>"}

RĂSPUNS:
"""${text.slice(0, 6000)}"""`;
  const out = await complete(prompt, cfg);
  const m = out?.match(/\{[\s\S]*\}/);
  if (!m) return ex;
  try {
    const j = JSON.parse(m[0]);
    const mentions = ex.mentions.map((x) => (x.own ? { ...x, recommended: !!j.recommended, sentiment: Math.max(0, Math.min(10, Number(j.sentiment) || x.sentiment)) } : x));
    const own = mentions.find((x) => x.own)!;
    return { ...ex, mentions, ownRecommended: own.recommended, ownSentiment: own.sentiment };
  } catch {
    return ex;
  }
}
