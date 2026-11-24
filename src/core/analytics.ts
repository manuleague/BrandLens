// Analitică la nivelul instrumentelor de referință:
// - GEOflux: share of answers per brand (inclusiv neurmărite), tone score 0–10 cu prag minim, „AI tool #1”,
//   branduri numite / surse afișate per răspuns, pe motor; tipuri de surse; persone.
// - Ahrefs Brand Radar: mențiuni, citări, AI Share of Voice, topicuri, pagini citate, interogări fan-out.
// - Moz / Semrush: share of mentions în timp per brand, comparație side-by-side, percepție (ce spune AI-ul).
// Totul calculat din răspunsurile stocate — nimic estimat sau introdus manual.

import type { BrandHit, EngineId, PromptDef, Project, StoredResult } from './types.ts';
import { normalize, sameSite, wilson } from './util.ts';

export interface BrandStat {
  brand: string;
  own: boolean;
  tracked: boolean;
  answers: number; // răspunsuri care îl numesc
  shareOfAnswers: number; // answers / răspunsuri valide
  shareOfVoice: number; // mențiuni / toate mențiunile de branduri
  avgPosition: number | null;
  recommendedRate: number; // din răspunsurile care îl numesc
  tone: number | null; // 0..10, null sub pragul minim
  toneN: number;
  firstPlace: number; // de câte ori e primul numit
  byEngine: Partial<Record<EngineId, number>>; // share of answers pe motor
  attributes: { text: string; polarity: 'pos' | 'neg' | 'neu'; count: number }[];
}

export interface AnalyticsReport {
  validAnswers: number;
  brands: BrandStat[];
  engineTop: Partial<Record<EngineId, { brand: string; share: number; ownShare: number; ownRank: number | null }>>;
  engineAverages: Partial<Record<EngineId | 'all', { n: number; brandsPerAnswer: number; sourcesPerAnswer: number; queriesPerAnswer: number }>>;
  topics: { topic: string; prompts: number; n: number; visibility: number; ci: [number, number]; leader: string; leaderShare: number; ownRank: number | null }[];
  personas: { persona: string; n: number; visibility: number; leader: string }[];
  brandTrend: { date: string; brand: string; share: number; n: number }[];
  trendBrands: string[];
  ownCitedPages: { url: string; title?: string; count: number; engines: EngineId[]; prompts: number }[];
  competitorCitedPages: { url: string; domain: string; brand: string; count: number }[];
  fanout: { query: string; count: number; engines: EngineId[] }[];
  visibilityScore: { score: number; parts: { label: string; value: number; weight: number }[] };
  mentionsWithSource: number; // % din răspunsurile care te numesc și care citează și site-ul tău
  localTldShare: number; // % din linkuri pe TLD-ul țării (.ro)
  perception: {
    pos: { text: string; count: number }[];
    neg: { text: string; count: number }[];
    quotes: { engine: EngineId; prompt: string; text: string; sentiment: number }[];
    toneByEngine: Partial<Record<EngineId, number>>;
  };
  deltas: { prevDate: string | null; lastDate: string | null; visibility: number | null; shareOfVoice: number | null; avgPosition: number | null };
  analysisMix: { llm: number; rules: number };
  minToneSample: number;
}

const avg = (a: number[]) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);

/** Brandurile unui răspuns: din analiza nouă (brands) sau, pentru rezultate vechi, din mențiuni + descoperiri. */
export function brandsOf(r: StoredResult): BrandHit[] {
  const e = r.extraction;
  if (e.brands?.length) return e.brands;
  const ranked = e.ranked ?? [...e.mentions.map((m) => m.brand), ...e.discovered];
  return ranked.map((name, i) => {
    const m = e.mentions.find((x) => x.brand === name);
    return { name, own: !!m?.own, tracked: !!m, position: i + 1, recommended: m ? m.recommended : false, sentiment: m ? m.sentiment : 6, attributes: [] };
  });
}

export function computeAnalytics(results: StoredResult[], prompts: PromptDef[], p: Project, opts: { minToneSample?: number } = {}): AnalyticsReport {
  const minTone = opts.minToneSample ?? 5;
  const pmap = new Map(prompts.map((x) => [x.id, x]));
  const discovery = results.filter((r) => pmap.get(r.promptId)?.intent !== 'brand');
  const valid = discovery.filter((r) => !r.error && !r.extraction.refusal);
  const n = valid.length;
  const engines = [...new Set(valid.map((r) => r.engine))];

  // ── Statistici pe brand
  type Acc = { brand: string; own: boolean; tracked: boolean; answers: Set<string>; pos: number[]; rec: number; tones: number[]; first: number; eng: Map<EngineId, number>; attrs: Map<string, { text: string; polarity: 'pos' | 'neg' | 'neu'; count: number }> };
  const acc = new Map<string, Acc>();
  let totalMentions = 0;
  for (const r of valid) {
    for (const b of brandsOf(r)) {
      const key = normalize(b.name);
      if (!key) continue;
      const a: Acc = acc.get(key) ?? { brand: b.name, own: b.own, tracked: b.tracked, answers: new Set<string>(), pos: [], rec: 0, tones: [], first: 0, eng: new Map(), attrs: new Map() };
      if (a.answers.has(r.id)) continue;
      a.answers.add(r.id);
      a.own ||= b.own;
      a.tracked ||= b.tracked;
      a.pos.push(b.position);
      if (b.recommended) a.rec++;
      a.tones.push(b.sentiment);
      if (b.position === 1) a.first++;
      a.eng.set(r.engine, (a.eng.get(r.engine) ?? 0) + 1);
      for (const at of b.attributes) {
        const k = normalize(at.text);
        const x = a.attrs.get(k) ?? { text: at.text, polarity: at.polarity, count: 0 };
        x.count++;
        a.attrs.set(k, x);
      }
      acc.set(key, a);
      totalMentions++;
    }
  }
  const engN = new Map<EngineId, number>();
  valid.forEach((r) => engN.set(r.engine, (engN.get(r.engine) ?? 0) + 1));
  const brands: BrandStat[] = [...acc.values()]
    .map((a) => ({
      brand: a.brand,
      own: a.own,
      tracked: a.tracked,
      answers: a.answers.size,
      shareOfAnswers: n ? a.answers.size / n : 0,
      shareOfVoice: totalMentions ? a.answers.size / totalMentions : 0,
      avgPosition: avg(a.pos),
      recommendedRate: a.answers.size ? a.rec / a.answers.size : 0,
      tone: a.tones.length >= minTone ? avg(a.tones) : null,
      toneN: a.tones.length,
      firstPlace: a.first,
      byEngine: Object.fromEntries([...a.eng.entries()].map(([e, c]) => [e, c / (engN.get(e) || 1)])),
      attributes: [...a.attrs.values()].sort((x, y) => y.count - x.count).slice(0, 8),
    }))
    .sort((x, y) => y.answers - x.answers);
  if (!brands.some((b) => b.own)) brands.push({ brand: p.name, own: true, tracked: true, answers: 0, shareOfAnswers: 0, shareOfVoice: 0, avgPosition: null, recommendedRate: 0, tone: null, toneN: 0, firstPlace: 0, byEngine: {}, attributes: [] });

  // ── „AI tool #1” și mediile per răspuns pe motor
  const engineTop: AnalyticsReport['engineTop'] = {};
  const engineAverages: AnalyticsReport['engineAverages'] = {};
  const avgFor = (rs: StoredResult[]) => ({
    n: rs.length,
    brandsPerAnswer: avg(rs.map((r) => brandsOf(r).length)) ?? 0,
    sourcesPerAnswer: avg(rs.map((r) => r.citations.filter((c) => c.kind === 'cited').length)) ?? 0,
    queriesPerAnswer: avg(rs.map((r) => r.searchQueries.length)) ?? 0,
  });
  engineAverages.all = avgFor(valid);
  for (const e of engines) {
    const ranked = brands.filter((b) => b.byEngine[e]).sort((a, b) => (b.byEngine[e] ?? 0) - (a.byEngine[e] ?? 0));
    const ownIdx = ranked.findIndex((b) => b.own);
    if (ranked[0]) engineTop[e] = { brand: ranked[0].brand, share: ranked[0].byEngine[e] ?? 0, ownShare: ranked[ownIdx]?.byEngine[e] ?? 0, ownRank: ownIdx >= 0 ? ownIdx + 1 : null };
    engineAverages[e] = avgFor(valid.filter((r) => r.engine === e));
  }

  // ── Topicuri (ca Ahrefs/Semrush) și persone (ca GEOflux)
  const topicNames = [...new Set(prompts.filter((x) => x.intent !== 'brand').map((x) => x.topic || x.tags[0] || 'General'))];
  const leaderOf = (rs: StoredResult[]) => {
    const c = new Map<string, { name: string; count: number; own: boolean }>();
    rs.forEach((r) => brandsOf(r).forEach((b) => {
      const k = normalize(b.name);
      const x = c.get(k) ?? { name: b.name, count: 0, own: b.own };
      x.count++;
      c.set(k, x);
    }));
    const sorted = [...c.values()].sort((a, b) => b.count - a.count);
    const ownIdx = sorted.findIndex((x) => x.own);
    return { leader: sorted[0]?.name ?? '—', leaderShare: sorted[0] && rs.length ? sorted[0].count / rs.length : 0, ownRank: ownIdx >= 0 ? ownIdx + 1 : null };
  };
  const topics = topicNames.map((topic) => {
    const ids = new Set(prompts.filter((x) => (x.topic || x.tags[0] || 'General') === topic && x.intent !== 'brand').map((x) => x.id));
    const rs = valid.filter((r) => ids.has(r.promptId));
    const k = rs.filter((r) => r.extraction.ownMentioned).length;
    return { topic, prompts: ids.size, n: rs.length, visibility: rs.length ? k / rs.length : 0, ci: wilson(k, rs.length), ...leaderOf(rs) };
  }).sort((a, b) => b.n - a.n);
  const personaNames = [...new Set(valid.map((r) => r.persona ?? 'Fără personă'))];
  const personas = personaNames.map((persona) => {
    const rs = valid.filter((r) => (r.persona ?? 'Fără personă') === persona);
    return { persona, n: rs.length, visibility: rs.length ? rs.filter((r) => r.extraction.ownMentioned).length / rs.length : 0, leader: leaderOf(rs).leader };
  });

  // ── Share of answers în timp pentru brandul propriu + top 5 (ca Moz „Share of Mentions Over Time”)
  const trendBrands = [brands.find((b) => b.own)!.brand, ...brands.filter((b) => !b.own).slice(0, 5).map((b) => b.brand)];
  const byDay = new Map<string, StoredResult[]>();
  valid.forEach((r) => byDay.set(r.createdAt.slice(0, 10), [...(byDay.get(r.createdAt.slice(0, 10)) ?? []), r]));
  const brandTrend: AnalyticsReport['brandTrend'] = [];
  for (const [date, rs] of [...byDay.entries()].sort()) {
    for (const b of trendBrands) {
      const k = normalize(b);
      const c = rs.filter((r) => brandsOf(r).some((x) => normalize(x.name) === k)).length;
      brandTrend.push({ date, brand: b, share: c / rs.length, n: rs.length });
    }
  }

  // ── Pagini citate (Ahrefs „Cited pages”) și interogări fan-out
  const ownPages = new Map<string, { url: string; title?: string; count: number; engines: Set<EngineId>; prompts: Set<string> }>();
  const compPages = new Map<string, { url: string; domain: string; brand: string; count: number }>();
  const fan = new Map<string, { query: string; count: number; engines: Set<EngineId> }>();
  let links = 0;
  let localLinks = 0;
  const tld = '.' + (p.country || 'RO').toLowerCase();
  for (const r of valid) {
    for (const c of r.citations.filter((x) => x.kind === 'cited')) {
      links++;
      if (c.domain.endsWith(tld)) localLinks++;
      if (sameSite(c.domain, p.domain)) {
        const x = ownPages.get(c.url) ?? { url: c.url, title: c.title, count: 0, engines: new Set(), prompts: new Set() };
        x.count++;
        x.engines.add(r.engine);
        x.prompts.add(r.promptId);
        ownPages.set(c.url, x);
      } else {
        const comp = p.competitors.find((cc) => cc.domain && sameSite(c.domain, cc.domain));
        if (comp) {
          const x = compPages.get(c.url) ?? { url: c.url, domain: c.domain, brand: comp.name, count: 0 };
          x.count++;
          compPages.set(c.url, x);
        }
      }
    }
    for (const q of r.searchQueries) {
      const k = normalize(q).trim();
      if (!k) continue;
      const x = fan.get(k) ?? { query: q, count: 0, engines: new Set() };
      x.count++;
      x.engines.add(r.engine);
      fan.set(k, x);
    }
  }

  // ── Scor de vizibilitate AI (compozit, formulă afișată în interfață)
  const own = brands.find((b) => b.own)!;
  const ownAnswers = valid.filter((r) => r.extraction.ownMentioned);
  const citeRate = n ? valid.filter((r) => r.extraction.ownCited).length / n : 0;
  const posScore = own.avgPosition ? Math.max(0, 1 - (own.avgPosition - 1) / 9) : 0;
  const ownTone = own.toneN ? (avg(ownAnswers.map((r) => brandsOf(r).find((b) => b.own)?.sentiment ?? 5)) ?? 5) : 0;
  const parts = [
    { label: 'Share of answers', value: own.shareOfAnswers, weight: 0.5 },
    { label: 'Poziție (1 = 100%)', value: posScore, weight: 0.2 },
    { label: 'Site citat ca sursă', value: citeRate, weight: 0.2 },
    { label: 'Ton', value: ownTone / 10, weight: 0.1 },
  ];
  const score = Math.round(parts.reduce((s, x) => s + x.value * x.weight, 0) * 100);

  // ── Percepție: ce spune AI-ul despre brandul tău
  const posA = new Map<string, number>();
  const negA = new Map<string, number>();
  const quotes: AnalyticsReport['perception']['quotes'] = [];
  const toneByEngine: Partial<Record<EngineId, number>> = {};
  for (const e of engines) {
    const t = ownAnswers.filter((r) => r.engine === e).map((r) => brandsOf(r).find((b) => b.own)?.sentiment ?? 5);
    if (t.length) toneByEngine[e] = avg(t)!;
  }
  for (const r of ownAnswers) {
    const b = brandsOf(r).find((x) => x.own);
    b?.attributes.forEach((a) => {
      if (a.polarity === 'pos') posA.set(a.text, (posA.get(a.text) ?? 0) + 1);
      if (a.polarity === 'neg') negA.set(a.text, (negA.get(a.text) ?? 0) + 1);
    });
    const m = r.extraction.mentions.find((x) => x.own);
    if (m?.snippet && quotes.length < 12 && !quotes.some((q) => q.text === m.snippet)) quotes.push({ engine: r.engine, prompt: pmap.get(r.promptId)?.text ?? '', text: m.snippet, sentiment: b?.sentiment ?? m.sentiment });
  }
  const top = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10).map(([text, count]) => ({ text, count }));

  // ── Delta: ultima zi de rulare vs precedenta
  const days = [...byDay.keys()].sort();
  const lastD = days.at(-1) ?? null;
  const prevD = days.length > 1 ? days.at(-2)! : null;
  const dayStat = (d: string | null) => {
    if (!d) return null;
    const rs = byDay.get(d)!;
    const k = rs.filter((r) => r.extraction.ownMentioned);
    const totalM = rs.reduce((s, r) => s + brandsOf(r).length, 0);
    return { vis: k.length / rs.length, sov: totalM ? k.length / totalM : 0, pos: avg(k.map((r) => r.extraction.ownPosition ?? 0).filter(Boolean)) };
  };
  const L = dayStat(lastD);
  const P = dayStat(prevD);

  return {
    validAnswers: n,
    brands,
    engineTop,
    engineAverages,
    topics,
    personas,
    brandTrend,
    trendBrands,
    ownCitedPages: [...ownPages.values()].sort((a, b) => b.count - a.count).slice(0, 30).map((x) => ({ ...x, engines: [...x.engines], prompts: x.prompts.size })),
    competitorCitedPages: [...compPages.values()].sort((a, b) => b.count - a.count).slice(0, 20),
    fanout: [...fan.values()].sort((a, b) => b.count - a.count).slice(0, 60).map((x) => ({ ...x, engines: [...x.engines] })),
    visibilityScore: { score, parts },
    mentionsWithSource: ownAnswers.length ? ownAnswers.filter((r) => r.extraction.ownCited).length / ownAnswers.length : 0,
    localTldShare: links ? localLinks / links : 0,
    perception: { pos: top(posA), neg: top(negA), quotes, toneByEngine },
    deltas: {
      prevDate: prevD,
      lastDate: lastD,
      visibility: L && P ? L.vis - P.vis : null,
      shareOfVoice: L && P ? L.sov - P.sov : null,
      avgPosition: L?.pos != null && P?.pos != null ? L.pos - P.pos : null,
    },
    analysisMix: { llm: valid.filter((r) => r.extraction.analysis === 'llm').length, rules: valid.filter((r) => r.extraction.analysis !== 'llm').length },
    minToneSample: minTone,
  };
}

