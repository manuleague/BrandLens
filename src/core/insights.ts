// Recomandări generate de AI din DATELE proiectului (nu din șabloane): unde pierzi, cine câștigă,
// ce surse îi susțin pe competitori, ce spune AI-ul despre tine, ce a găsit auditul.
// Fiecare recomandare trebuie să citeze dovezile din care provine.

import type { AnalyticsReport } from './analytics.ts';
import type { EngineConfig } from './engines.ts';
import { llmJson } from './llm.ts';
import type { MetricsReport } from './metrics.ts';
import type { SourceRow } from './sources.ts';
import type { ActionCategory, ActionItem, AuditResult, Project } from './types.ts';
import { normalize } from './util.ts';

export async function generateInsights(p: Project, m: MetricsReport, a: AnalyticsReport, sources: SourceRow[], audit: AuditResult | null, cfg: EngineConfig): Promise<{ items: ActionItem[]; costUsd: number; error?: string }> {
  const own = a.brands.find((b) => b.own);
  const lost = m.prompts.filter((x) => x.intent !== 'brand' && Object.keys(x.perEngine).length && x.visibility === 0).slice(0, 12);
  const evidence = {
    brand: p.name,
    domain: p.domain,
    category: p.category,
    scope: p.scope ?? (p.city ? 'local' : 'national'),
    validAnswers: a.validAnswers,
    ownShareOfAnswers: own?.shareOfAnswers,
    ownAvgPosition: own?.avgPosition,
    ownTone: own?.tone,
    perEngine: Object.fromEntries(Object.entries(a.engineTop).map(([e, t]) => [e, { leader: t!.brand, leaderShare: t!.share, ownShare: t!.ownShare, ownRank: t!.ownRank }])),
    topCompetitors: a.brands.filter((b) => !b.own).slice(0, 6).map((b) => ({ brand: b.brand, share: b.shareOfAnswers, saidAbout: b.attributes.slice(0, 4).map((x) => x.text) })),
    whatAISaysAboutYou: { positive: a.perception.pos.slice(0, 6), negative: a.perception.neg.slice(0, 6) },
    topicsWhereWeak: a.topics.filter((t) => t.n >= 2).sort((x, y) => x.visibility - y.visibility).slice(0, 5).map((t) => ({ topic: t.topic, visibility: t.visibility, leader: t.leader })),
    lostPrompts: lost.map((x) => ({ prompt: x.text, winners: x.winners.slice(0, 3).map((w) => w.brand) })),
    sourceGaps: sources.filter((s) => s.gapScore > 0).slice(0, 10).map((s) => ({ domain: s.domain, type: s.type, shareOfAnswers: s.share, withYou: s.withOwn, withoutYou: s.withCompetitors, sampleUrls: s.urls.slice(0, 2).map((u) => u.url) })),
    ownCitedPages: a.ownCitedPages.slice(0, 5).map((x) => x.url),
    searchQueriesAIUsed: a.fanout.slice(0, 15).map((f) => f.query),
    auditFailures: (audit?.findings ?? []).filter((f) => f.status === 'fail' || f.status === 'warn').slice(0, 12).map((f) => `${f.title}: ${f.detail}`),
  };
  const prompt = `You are a senior GEO strategist. Using ONLY the evidence below (real measurements of AI-assistant answers), write the highest-impact actions to increase how often AI assistants recommend "${p.name}".

EVIDENCE (JSON):
${JSON.stringify(evidence).slice(0, 14000)}

Rules:
- 6 to 10 actions, most impactful first. Each must be specific to this brand and cite the evidence it comes from (prompt, domain, competitor, number).
- Prefer actions that change what the cited sources say, fill lost prompts with answer-ready pages, fix negative perception, and close engine-specific gaps.
- No generic advice that would apply to any website. No invented facts or numbers.
- Romanian with diacritics.

Return JSON: {"actions":[{"title":string,"why":string,"steps":string[] (3-6 concrete steps),"acceptance":string (how to verify, measurable),"category":"technical"|"entity"|"content"|"offsite"|"reputation"|"measurement","impact":1-5,"effort":1-5,"evidence":string[]}]}`;
  const { data, usage } = await llmJson<{ actions: { title: string; why: string; steps: string[]; acceptance: string; category: string; impact: number; effort: number; evidence?: string[] }[] }>(prompt, cfg, { maxTokens: 4000 });
  if (!data?.actions) return { items: [], costUsd: usage.costUsd, error: usage.error ?? 'Răspuns AI invalid.' };
  const cats: ActionCategory[] = ['technical', 'entity', 'content', 'offsite', 'reputation', 'measurement'];
  const items: ActionItem[] = data.actions
    .filter((x) => x && typeof x.title === 'string' && Array.isArray(x.steps))
    .slice(0, 10)
    .map((x) => {
      const impact = Math.max(1, Math.min(5, Math.round(Number(x.impact) || 3)));
      const effort = Math.max(1, Math.min(5, Math.round(Number(x.effort) || 3)));
      const s = Math.round(((impact * 4 * 3) / effort) * 10) / 10;
      return {
        key: `ai:${normalize(x.title).replace(/[^a-z0-9]+/g, '-').slice(0, 60)}`,
        category: cats.includes(x.category as ActionCategory) ? (x.category as ActionCategory) : 'content',
        title: x.title,
        why: x.why ?? '',
        steps: x.steps.map(String).slice(0, 8),
        acceptance: x.acceptance ?? '',
        impact,
        effort,
        confidence: 3,
        gap: 4,
        priorityScore: s,
        priority: s >= 40 ? 'P0' : s >= 18 ? 'P1' : 'P2',
        evidence: (x.evidence ?? []).map(String).slice(0, 6),
        aiGenerated: true,
      } as ActionItem;
    });
  return { items, costUsd: usage.costUsd };
}
