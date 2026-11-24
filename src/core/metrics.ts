// Metrici GEO cu eșantion transparent (n, interval Wilson), separate pe motor, intenție și prompt.
// Prompturile de tip „brand” sunt excluse din vizibilitate/SoV (numesc brandul în întrebare).

import type { EngineId, MetricBlock, PromptDef, StoredResult } from './types.ts';
import { wilson } from './util.ts';

export function block(rs: StoredResult[]): MetricBlock {
  const valid = rs.filter((r) => !r.error && !r.extraction.refusal);
  const n = valid.length;
  const ment = valid.filter((r) => r.extraction.ownMentioned);
  const cited = valid.filter((r) => r.extraction.ownCited).length;
  const allMentions = valid.reduce((s, r) => s + r.extraction.mentions.length, 0);
  const pos = ment.map((r) => r.extraction.ownPosition!).filter((x) => x > 0);
  const sent = ment.map((r) => r.extraction.ownSentiment!).filter((x) => x !== null);
  return {
    n,
    visibility: n ? ment.length / n : 0,
    visibilityCi: wilson(ment.length, n),
    citationRate: n ? cited / n : 0,
    shareOfVoice: allMentions ? ment.length / allMentions : 0,
    avgPosition: pos.length ? pos.reduce((a, b) => a + b, 0) / pos.length : null,
    recommendationRate: ment.length ? ment.filter((r) => r.extraction.ownRecommended).length / ment.length : 0,
    sentiment: sent.length ? sent.reduce((a, b) => a + b, 0) / sent.length : null,
    errors: rs.length - valid.length,
  };
}

export interface LeaderRow {
  brand: string;
  own: boolean;
  tracked: boolean;
  mentions: number;
  visibility: number;
  avgPosition: number | null;
  recommended: number;
}

export interface PromptRow {
  promptId: string;
  text: string;
  intent: string;
  perEngine: Partial<Record<EngineId, { n: number; mentioned: number; cited: number }>>;
  visibility: number;
  winners: { brand: string; count: number }[];
  volatile: boolean;
}

export interface GridRow {
  n: number;
  missPct: number;
  cells: { pos: number; ownPct: number; top: string; topPct: number }[];
}

export interface MetricsReport {
  grid: Partial<Record<EngineId, GridRow>>;
  overall: MetricBlock;
  byEngine: Partial<Record<EngineId, MetricBlock>>;
  byIntent: Record<string, MetricBlock>;
  leaderboard: LeaderRow[];
  prompts: PromptRow[];
  trend: { date: string; engine: EngineId | 'all'; visibility: number; n: number }[];
  costUsd: number;
  totalAnswers: number;
  lastRunAt: string | null;
  accuracyIssues: number;
  engines: EngineId[];
}

export function computeMetrics(results: StoredResult[], prompts: PromptDef[], ownName: string): MetricsReport {
  const pmap = new Map(prompts.map((p) => [p.id, p]));
  const discovery = results.filter((r) => pmap.get(r.promptId)?.intent !== 'brand');
  const valid = discovery.filter((r) => !r.error && !r.extraction.refusal);
  const engines = [...new Set(results.map((r) => r.engine))];

  const byEngine: Partial<Record<EngineId, MetricBlock>> = {};
  for (const e of engines) byEngine[e] = block(discovery.filter((r) => r.engine === e));

  const byIntent: Record<string, MetricBlock> = {};
  for (const r of discovery) {
    const it = pmap.get(r.promptId)?.intent ?? 'other';
    if (!byIntent[it]) byIntent[it] = block(discovery.filter((x) => (pmap.get(x.promptId)?.intent ?? 'other') === it));
  }

  // Clasament: branduri urmărite + cele mai frecvente entități descoperite.
  const lb = new Map<string, LeaderRow & { posSum: number; posN: number }>();
  const bump = (brand: string, own: boolean, tracked: boolean, pos: number | null, rec: boolean) => {
    const row = lb.get(brand) ?? { brand, own, tracked, mentions: 0, visibility: 0, avgPosition: null, recommended: 0, posSum: 0, posN: 0 };
    row.mentions++;
    if (pos) {
      row.posSum += pos;
      row.posN++;
    }
    if (rec) row.recommended++;
    lb.set(brand, row);
  };
  for (const r of valid) {
    for (const m of r.extraction.mentions) bump(m.brand, m.own, true, m.position, m.recommended);
    for (const d of r.extraction.discovered) bump(d, false, false, null, false);
  }
  if (!lb.has(ownName)) lb.set(ownName, { brand: ownName, own: true, tracked: true, mentions: 0, visibility: 0, avgPosition: null, recommended: 0, posSum: 0, posN: 0 });
  const leaderboard = [...lb.values()]
    .map(({ posSum, posN, ...row }) => ({ ...row, visibility: valid.length ? row.mentions / valid.length : 0, avgPosition: posN ? posSum / posN : null }))
    .filter((r) => r.tracked || r.mentions >= 2)
    .sort((a, b) => b.mentions - a.mentions)
    .slice(0, 20);

  const promptsRows: PromptRow[] = prompts.map((p) => {
    const rs = results.filter((r) => r.promptId === p.id && !r.error && !r.extraction.refusal);
    const perEngine: PromptRow['perEngine'] = {};
    for (const r of rs) {
      const pe = (perEngine[r.engine] ??= { n: 0, mentioned: 0, cited: 0 });
      pe.n++;
      if (r.extraction.ownMentioned) pe.mentioned++;
      if (r.extraction.ownCited) pe.cited++;
    }
    const wins = new Map<string, number>();
    rs.forEach((r) => r.extraction.mentions.filter((m) => !m.own).forEach((m) => wins.set(m.brand, (wins.get(m.brand) ?? 0) + 1)));
    rs.forEach((r) => r.extraction.discovered.slice(0, 5).forEach((d) => wins.set(d, (wins.get(d) ?? 0) + 1)));
    // Volatilitate: același motor, repetiții cu rezultat diferit.
    const volatile = Object.values(perEngine).some((pe) => pe!.n >= 2 && pe!.mentioned > 0 && pe!.mentioned < pe!.n);
    const ment = rs.filter((r) => r.extraction.ownMentioned).length;
    return {
      promptId: p.id,
      text: p.text,
      intent: p.intent,
      perEngine,
      visibility: rs.length ? ment / rs.length : 0,
      winners: [...wins.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([brand, count]) => ({ brand, count })),
      volatile,
    };
  });

  const days = new Map<string, StoredResult[]>();
  discovery.forEach((r) => {
    const d = r.createdAt.slice(0, 10);
    days.set(d, [...(days.get(d) ?? []), r]);
  });
  const trend: MetricsReport['trend'] = [];
  for (const [date, rs] of [...days.entries()].sort()) {
    const b = block(rs);
    trend.push({ date, engine: 'all', visibility: b.visibility, n: b.n });
    for (const e of engines) {
      const be = block(rs.filter((r) => r.engine === e));
      if (be.n) trend.push({ date, engine: e, visibility: be.visibility, n: be.n });
    }
  }

  // Grila de poziții: pentru fiecare motor, cine apare pe locurile 1..6 și cât de des ești tu acolo.
  const grid: Partial<Record<EngineId, GridRow>> = {};
  for (const e of engines) {
    const rs = valid.filter((r) => r.engine === e);
    if (!rs.length) continue;
    const cells: GridRow['cells'] = [];
    for (let pos = 1; pos <= 6; pos++) {
      const counts = new Map<string, number>();
      let own = 0;
      for (const r of rs) {
        const ranked = r.extraction.ranked ?? r.extraction.mentions.map((m) => m.brand);
        const name = ranked[pos - 1];
        if (!name) continue;
        if (name === ownName) own++;
        else counts.set(name, (counts.get(name) ?? 0) + 1);
      }
      const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
      cells.push({ pos, ownPct: own / rs.length, top: top?.[0] ?? '', topPct: top ? top[1] / rs.length : 0 });
    }
    grid[e] = { n: rs.length, missPct: rs.filter((r) => !r.extraction.ownMentioned).length / rs.length, cells };
  }

  return {
    grid,
    overall: block(discovery),
    byEngine,
    byIntent,
    leaderboard,
    prompts: promptsRows,
    trend,
    costUsd: results.reduce((s, r) => s + (r.usage.costUsd ?? 0), 0),
    totalAnswers: results.length,
    lastRunAt: results.length ? results.map((r) => r.createdAt).sort().at(-1)! : null,
    accuracyIssues: results.filter((r) => r.extraction.accuracy.length).length,
    engines,
  };
}
