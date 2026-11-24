// Logica aplicației: proiecte, profilare AI, prompturi, rulări, analiză, audit, acțiuni, generatoare,
// optimizator de conținut, loguri crawlere, demo, programare.

import { computeAnalytics, type AnalyticsReport } from '../core/analytics.ts';
import { AUDIT_VERSION, liveAudit, runAudit, scoreFindings, type TrackingSummary } from '../core/audit.ts';
import { crawlSite } from '../core/crawler.ts';
import { configFromEnv, engineStatus, runEngine, testEngines, type EngineConfig } from '../core/engines.ts';
import { analyzeWithLLM, extract, judge } from '../core/extract.ts';
import { generate, type Generated } from '../core/generators.ts';
import { generateInsights } from '../core/insights.ts';
import { analysisProvider, isDailyQuota, retryAfterSeconds } from '../core/llm.ts';
import { LogAnalyzer, type LogReport } from '../core/logs.ts';
import { computeMetrics, type MetricsReport } from '../core/metrics.ts';
import { optimizePage, type OptimizeResult } from '../core/optimize.ts';
import { profileSite, type SiteProfile } from '../core/profile.ts';
import { brandPrompts, generatePrompts, generatePromptsAI, isLocal, type GeneratedPrompt } from '../core/prompts.ts';
import { buildActions } from '../core/recommend.ts';
import { simulateAnswer } from '../core/simulator.ts';
import { analyzeSources, type SourceRow } from '../core/sources.ts';
import type { ActionItem, ActionStatus, AuditResult, EngineId, EngineRequest, GeneratorKind, Persona, Project, PromptDef, StoredResult } from '../core/types.ts';
import { domainOf, normalize, pool, sameSite, uid } from '../core/util.ts';
import { auditReadable, type ActionState, type JobRow, type Store } from './db.ts';

export interface ActionView extends ActionItem {
  state: ActionState;
}

export interface Dashboard {
  metrics: MetricsReport;
  analytics: AnalyticsReport;
  sources: ReturnType<typeof analyzeSources>;
  tracking: TrackingSummary;
  audit: AuditResult | null;
  /** Ultimul audit n-a putut citi site-ul; afișăm auditul bun anterior și explicăm de ce. */
  auditBlocked?: { at: string; reason: string; showingFrom?: string };
}

export class Service {
  store: Store;
  cfg: EngineConfig;
  useJudge: boolean;
  log: (...a: unknown[]) => void;
  private cache = new Map<string, { at: number; key: string; value: Dashboard }>();

  constructor(store: Store, env: Record<string, string | undefined> = process.env, log: (...a: unknown[]) => void = console.log) {
    this.store = store;
    this.cfg = configFromEnv(env);
    this.useJudge = env.LLM_JUDGE === '1';
    this.log = log;
  }

  engines() {
    return engineStatus(this.cfg);
  }

  analysisInfo() {
    const ap = analysisProvider(this.cfg);
    return ap ? { enabled: true, provider: ap.provider, model: ap.model } : { enabled: false, provider: null, model: null };
  }

  testEngines() {
    return testEngines(this.cfg);
  }

  // ── Profilare AI a site-ului (onboarding)
  profile(domain: string): Promise<SiteProfile> {
    return profileSite(domain, this.cfg);
  }

  private savePrompts(projectId: string, gs: GeneratedPrompt[]): number {
    let n = 0;
    const have = new Set(this.store.listPrompts(projectId).map((q) => normalize(q.text)));
    for (const g of gs) {
      const k = normalize(g.text);
      if (have.has(k)) continue;
      have.add(k);
      this.store.savePrompt({ id: uid('q_'), projectId, text: g.text, lang: g.lang, intent: g.intent, tags: g.tags, active: true, topic: g.topic, stage: g.stage, origin: g.origin });
      n++;
    }
    return n;
  }

  // ── Proiecte
  createProject(input: Partial<Project> & { name: string; domain: string }, opts: { promptCount?: number; aiSetup?: boolean } = {}): Project {
    const configured = (Object.entries(this.engines()) as [EngineId, { configured: boolean }][]).filter(([e, s]) => s.configured && e !== 'simulator').map(([e]) => e);
    const p: Project = {
      id: uid('p_'),
      name: input.name.trim(),
      domain: domainOf(input.domain),
      aliases: input.aliases ?? [],
      competitors: (input.competitors ?? []).filter((c) => c.name?.trim()).map((c) => ({ ...c, domain: c.domain ? domainOf(c.domain) : undefined })),
      vertical: input.vertical ?? 'generic',
      category: input.category,
      categoryEn: input.categoryEn,
      scope: input.scope,
      description: input.description,
      usps: input.usps,
      topics: input.topics ?? [],
      personas: input.personas ?? [],
      usePersonas: input.usePersonas ?? false,
      country: input.country ?? 'RO',
      city: input.city,
      region: input.region,
      neighborhoods: input.neighborhoods ?? [],
      services: input.services ?? [],
      languages: input.languages?.length ? input.languages : ['ro'],
      engines: input.engines?.length ? input.engines : configured,
      repetitions: input.repetitions ?? 3,
      schedule: input.schedule ?? 'weekly',
      facts: input.facts ?? {},
      shareToken: uid('r_') + uid(),
      createdAt: new Date().toISOString(),
      demo: input.demo,
    };
    if (p.scope === undefined) p.scope = p.vertical === 'restaurant' || p.vertical === 'local_service' ? 'local' : 'national';
    this.store.saveProject(p);
    // Șabloanele dau un set de pornire imediat; dacă există un LLM, jobul „setup” le înlocuiește cu prompturi generate.
    this.savePrompts(p.id, generatePrompts(p, opts.promptCount ?? 30));
    if (opts.aiSetup && !p.demo && analysisProvider(this.cfg)) this.store.enqueue({ id: uid('j_'), type: 'setup', projectId: p.id, payload: { perTopic: 4, thenRun: false } });
    return p;
  }

  updateProject(id: string, patch: Partial<Project>): Project | null {
    const cur = this.store.getProject(id);
    if (!cur) return null;
    const next: Project = { ...cur, ...patch, id: cur.id, shareToken: cur.shareToken, createdAt: cur.createdAt, domain: patch.domain ? domainOf(patch.domain) : cur.domain };
    this.store.saveProject(next);
    this.cache.delete(id);
    return next;
  }

  regeneratePrompts(id: string, replace: boolean): PromptDef[] {
    const p = this.store.getProject(id);
    if (!p) return [];
    if (replace) this.store.listPrompts(id).forEach((e) => this.store.deletePrompt(e.id));
    this.savePrompts(id, generatePrompts(p, 40));
    return this.store.listPrompts(id);
  }

  /** Prompt research cu AI (sincron, pentru butonul din interfață). */
  async aiPrompts(id: string, opts: { perTopic?: number; topics?: string[]; replaceTemplates?: boolean } = {}): Promise<{ added: number; costUsd: number; error?: string }> {
    const p = this.store.getProject(id);
    if (!p) throw new Error('Proiect inexistent');
    const existing = this.store.listPrompts(id);
    const r = await generatePromptsAI(p, this.cfg, { perTopic: opts.perTopic, topics: opts.topics, existing: existing.map((q) => q.text) });
    if (r.error && !r.prompts.length) return { added: 0, costUsd: r.costUsd, error: r.error };
    if (opts.replaceTemplates) {
      const used = new Set(this.store.listResults(id).map((x) => x.promptId));
      existing.filter((q) => q.origin === 'template' && q.intent !== 'brand' && !used.has(q.id)).forEach((q) => this.store.deletePrompt(q.id));
    }
    const added = this.savePrompts(id, r.prompts);
    if (!this.store.listPrompts(id).some((q) => q.intent === 'brand')) this.savePrompts(id, brandPrompts(p).slice(0, 1));
    this.cache.delete(id);
    return { added, costUsd: r.costUsd, error: r.error };
  }

  async processSetup(job: JobRow): Promise<void> {
    const r = await this.aiPrompts(job.projectId, { perTopic: job.payload?.perTopic ?? 4, replaceTemplates: true });
    this.log(`[setup] ${job.projectId}: ${r.added} prompturi generate cu AI${r.error ? ` (${r.error})` : ''}`);
    if (job.payload?.thenRun) {
      try {
        this.startRun(job.projectId, { trigger: 'onboarding' });
      } catch (e) {
        this.log(`[setup] ${(e as Error).message}`);
      }
    }
  }

  // ── Rulări
  startRun(projectId: string, opts: { engines?: EngineId[]; repetitions?: number; promptIds?: string[]; trigger?: string; personas?: boolean } = {}): string {
    const p = this.store.getProject(projectId);
    if (!p) throw new Error('Proiect inexistent');
    // Rulăm doar pe motoarele care au cheie. Dacă niciunul dintre cele bifate nu are, folosim motoarele configurate
    // și le salvăm în proiect (altfel rularea ar eșua 100% cu „cheie lipsă”, cum se întâmpla la proiectele vechi).
    const st = this.engines();
    const PROVIDER_OF: Record<string, string> = { chatgpt: 'openai', claude: 'anthropic', gemini: 'gemini', perplexity: 'perplexity' };
    const ok = (e: EngineId) => !!st[e]?.configured && !this.cfg.brokenProviders?.has(PROVIDER_OF[e]);
    const wanted = opts.engines?.length ? opts.engines : p.engines;
    let engines = wanted.filter(ok);
    if (!engines.length && !p.demo) {
      engines = (Object.keys(st) as EngineId[]).filter((e) => e !== 'simulator' && ok(e));
      if (engines.length && !opts.engines?.length) {
        this.store.saveProject({ ...p, engines });
        this.log(`[run] ${p.name}: motoarele bifate (${wanted.join(', ') || '—'}) nu au cheie; rulez pe ${engines.join(', ')}`);
      }
    }
    if (p.demo) engines = wanted;
    if (!engines.length) throw new Error(`Niciun motor AI cu cheie validă${wanted.length ? ` (bifate: ${wanted.join(', ')})` : ''}. Adăugați cheia în .env, reporniți serverul și apăsați „Testează conexiunile”.`);
    const prompts = this.store.listPrompts(projectId).filter((q) => q.active && (!opts.promptIds || opts.promptIds.includes(q.id)));
    if (!prompts.length) throw new Error('Nu există prompturi active.');
    const reps = Math.max(1, Math.min(10, opts.repetitions ?? p.repetitions));
    const personas = (opts.personas ?? p.usePersonas) && p.personas?.length ? p.personas : [];
    const variants = 1 + personas.length;
    const runId = uid('run_');
    this.store.createRun({ id: runId, projectId, createdAt: new Date().toISOString(), status: 'queued', engines, total: prompts.length * engines.length * reps * variants, done: 0, errors: 0, costUsd: 0, trigger: opts.trigger ?? 'manual' });
    this.store.enqueue({ id: uid('j_'), type: 'run', projectId, payload: { runId, engines, reps, promptIds: prompts.map((q) => q.id), personas } });
    return runId;
  }

  private request(p: Project, prompt: PromptDef, persona?: Persona): EngineRequest {
    // Persona = cum s-ar prezenta utilizatorul în conversație (GEOflux pune fiecare întrebare și ca 3 tipuri de cumpărător).
    const text = persona && prompt.intent !== 'brand' ? `${persona.description}\n\n${prompt.text}` : prompt.text;
    return { prompt: text, lang: prompt.lang, country: p.country, city: isLocal(p) ? p.city : undefined, region: p.region, lat: p.facts.lat, lng: p.facts.lng, local: isLocal(p) };
  }

  async processRun(job: JobRow): Promise<void> {
    const { runId, engines, reps, promptIds, personas = [] } = job.payload as { runId: string; engines: EngineId[]; reps: number; promptIds: string[]; personas?: Persona[] };
    const p = this.store.getProject(job.projectId);
    if (!p) return;
    this.store.updateRun(runId, { status: 'running' });
    const prompts = this.store.listPrompts(p.id).filter((q) => promptIds.includes(q.id));
    const done = this.store.resultKeysForRun(runId);
    const variants: (Persona | undefined)[] = [undefined, ...personas];
    const tasks: { prompt: PromptDef; engine: EngineId; rep: number; persona?: Persona }[] = [];
    for (const prompt of prompts)
      for (const engine of engines)
        for (let rep = 1; rep <= reps; rep++)
          for (const persona of variants) {
            if (persona && prompt.intent === 'brand') continue;
            if (!done.has(`${prompt.id}|${engine}|${rep}|${persona?.name ?? ''}`)) tasks.push({ prompt, engine, rep, persona });
          }

    const useLLM = !p.demo && !!analysisProvider(this.cfg);
    const byEngine = new Map<EngineId, typeof tasks>();
    tasks.forEach((t) => byEngine.set(t.engine, [...(byEngine.get(t.engine) ?? []), t]));
    let count = done.size;
    let errors = 0;
    let cost = 0;
    const engineErrors = new Map<EngineId, string>();
    const authFailed = new Set<EngineId>();
    const quotaHits: Partial<Record<EngineId, number>> = Object.fromEntries(engines.map((e) => [e, 0]));
    await Promise.all(
      [...byEngine.entries()].map(([engine, list]) =>
        pool(list, p.demo ? 8 : 2, async (t) => {
          // Cheie respinsă (401/403) sau cotă epuizată: nu mai trimitem restul cererilor pe acel motor — eroarea se vede imediat.
          if (authFailed.has(engine)) {
            count++;
            errors++;
            return;
          }
          const req = this.request(p, t.prompt, t.persona);
          const r = p.demo
            ? { ...simulateAnswer(p, req.prompt, t.engine, `${runId}|${t.rep}|${t.persona?.name ?? ''}`, demoProgress(this.store, p.id)), latencyMs: 5 }
            : await this.withRetry(() => runEngine(t.engine, req, this.cfg));
          if (r.error) {
            engineErrors.set(engine, r.error);
            if (/\b(401|403)\b|invalid.*key|api key|unauthor/i.test(r.error)) authFailed.add(engine);
            // 429 care rămâne după reîncercări = cota e consumată; continuarea doar umple rularea cu erori.
            if (/\b429\b|quota|RESOURCE_EXHAUSTED/i.test(r.error) && (isDailyQuota(r.error) || (quotaHits[engine] = (quotaHits[engine] ?? 0) + 1) >= 2)) authFailed.add(engine);
          }
          let ex = extract(r.text, r.citations, p);
          let analysisCost = 0;
          if (useLLM && !r.error) {
            const a = await analyzeWithLLM(r.text, ex, p, this.cfg);
            ex = a.extraction;
            analysisCost = a.costUsd;
          } else if (this.useJudge && !r.error && !p.demo) ex = await judge(r.text, ex, p, this.cfg);
          const stored: StoredResult = { id: uid('r_'), projectId: p.id, runId, promptId: t.prompt.id, engine: t.engine, model: r.model, rep: t.rep, createdAt: new Date().toISOString(), text: r.text, citations: r.citations, searchQueries: r.searchQueries, usage: { ...r.usage, analysisCostUsd: analysisCost }, latencyMs: r.latencyMs, error: r.error, simulated: r.simulated, persona: t.persona?.name, extraction: ex };
          this.store.saveResult(stored);
          count++;
          if (r.error) errors++;
          cost += (r.usage.costUsd ?? 0) + analysisCost;
          if (count % 5 === 0) this.store.updateRun(runId, { done: count, errors, costUsd: cost, error: summarizeErrors(engineErrors) });
        }),
      ),
    );
    const total = count;
    const status = errors && errors === total - done.size ? 'failed' : 'done';
    this.store.updateRun(runId, { status, done: count, errors, costUsd: cost, error: summarizeErrors(engineErrors) });
    this.cache.delete(p.id);
    this.log(`[run] ${p.name}: ${count} răspunsuri, ${errors} erori, cost ~$${cost.toFixed(3)}${engineErrors.size ? ` — ${summarizeErrors(engineErrors)}` : ''}`);
  }

  /** Re-analizează cu LLM răspunsurile existente (după ce ați adăugat o cheie sau ați schimbat competitorii). */
  async processAnalyze(job: JobRow): Promise<void> {
    const p = this.store.getProject(job.projectId);
    if (!p) return;
    const rs = this.store.listResults(p.id, { sinceDays: job.payload?.days ?? 30 }).filter((r) => !r.error);
    const llm = !p.demo && !!analysisProvider(this.cfg);
    let n = 0;
    await pool(rs, 3, async (r) => {
      let ex = extract(r.text, r.citations, p);
      let c = 0;
      if (llm) {
        const a = await analyzeWithLLM(r.text, ex, p, this.cfg);
        ex = a.extraction;
        c = a.costUsd;
      }
      this.store.updateExtraction(r.id, ex, { ...r.usage, analysisCostUsd: (r.usage.analysisCostUsd ?? 0) + c });
      n++;
    });
    this.cache.delete(p.id);
    this.log(`[analyze] ${p.name}: ${n} răspunsuri re-analizate${llm ? ' cu LLM' : ''}`);
  }

  startReanalyze(projectId: string, days = 30): string {
    const id = uid('j_');
    this.store.enqueue({ id, type: 'analyze', projectId, payload: { days } });
    return id;
  }

  private async withRetry(fn: () => Promise<Awaited<ReturnType<typeof runEngine>>>) {
    let r = await fn();
    // 429 = limită de cereri (frecvent pe planurile gratuite): așteptăm mai mult înainte de reîncercare.
    for (let i = 0; i < 3 && r.error && /(429|500|502|503|529|Timeout|overloaded|rate|quota|RESOURCE_EXHAUSTED)/i.test(r.error); i++) {
      if (isDailyQuota(r.error)) break; // cota pe zi nu revine în câteva secunde
      const limited = /429|rate|quota|RESOURCE_EXHAUSTED/i.test(r.error);
      const wait = retryAfterSeconds(r.error);
      await new Promise((res) => setTimeout(res, wait ? Math.min(90, wait + 2) * 1000 : (limited ? 20000 : 3000) * (i + 1)));
      r = await fn();
    }
    return r;
  }

  // ── Audit
  startAudit(projectId: string, maxPages = 25): string {
    const id = uid('j_');
    this.store.enqueue({ id, type: 'audit', projectId, payload: { maxPages } });
    return id;
  }

  async processAudit(job: JobRow): Promise<void> {
    const p = this.store.getProject(job.projectId);
    if (!p) return;
    const crawl = await crawlSite(p.domain, { maxPages: job.payload?.maxPages ?? 25 });
    const view = this.dashboard(p.id);
    const audit = runAudit({ project: p, crawl, tracking: view.tracking, manualDone: this.manualDone(p.id) });
    this.store.saveAudit(uid('a_'), p.id, audit);
    this.log(audit.unreadable ? `[audit] ${p.name}: site-ul nu a putut fi citit (${audit.unreadable.reason}); se păstrează auditul anterior` : `[audit] ${p.name}: scor ${audit.score}/100, ${audit.pagesCrawled} pagini`);
  }

  private manualDone(projectId: string): Set<string> {
    const s = new Set<string>();
    for (const [k, v] of this.store.actionStates(projectId)) if (k.startsWith('check:') && (v.status === 'done' || v.status === 'verified')) s.add(k.slice(6));
    return s;
  }

  // ── Vederi agregate
  dashboard(projectId: string, days = 30): Dashboard {
    const p = this.store.getProject(projectId)!;
    const prompts = this.store.listPrompts(projectId);
    const results = this.store.listResults(projectId, { sinceDays: days });
    // Cache scurt: dashboard-ul e citit de mai multe ecrane la rând; cheia include numărul de rezultate și starea acțiunilor.
    const key = `${days}|${results.length}|${prompts.length}|${JSON.stringify(p).length}|${[...this.store.actionStates(projectId).values()].map((s) => s.status).join('')}|${this.store.latestAudit(projectId)?.finishedAt ?? ''}`;
    const hit = this.cache.get(projectId);
    if (hit && hit.key === key && Date.now() - hit.at < 15000) return hit.value;
    const metrics = computeMetrics(results, prompts, p.name);
    const analytics = computeAnalytics(results, prompts, p);
    const sources = analyzeSources(results, p);
    const third = sources.rows.filter((r) => !['owned', 'competitor', 'brand'].includes(r.type) && r.answers >= 2).slice(0, 15);
    const tracking: TrackingSummary = {
      enginesRun: Object.values(metrics.byEngine).filter((b) => b && b.n > 0).length,
      n: metrics.overall.n,
      visibility: metrics.overall.visibility,
      citationRate: metrics.overall.citationRate,
      accuracyIssues: metrics.accuracyIssues,
      topThirdParty: third.length,
      topThirdPartyWithOwn: third.filter((r) => r.withOwn > 0).length,
    };
    const raw = this.store.latestAudit(projectId);
    const stored = this.store.latestAudit(projectId, { readable: true }) ?? raw;
    const audit = stored ? liveAudit(stored, p, tracking, this.manualDone(projectId)) : null;
    const auditBlocked = raw && raw !== stored && !auditReadable(raw)
      ? { at: raw.finishedAt, reason: raw.unreadable?.reason ?? raw.findings.find((f) => f.id === 'home_https_200')?.detail ?? 'site-ul nu a răspuns', showingFrom: stored && auditReadable(stored) ? stored.finishedAt : undefined }
      : raw && !auditReadable(raw) ? { at: raw.finishedAt, reason: raw.unreadable?.reason ?? raw.findings.find((f) => f.id === 'home_https_200')?.detail ?? 'site-ul nu a răspuns' } : undefined;
    const value = { metrics, analytics, sources, tracking, audit, auditBlocked };
    this.cache.set(projectId, { at: Date.now(), key, value });
    return value;
  }

  /** Ultima rulare + eroarea ei (ca să nu mai afișăm „—” fără explicație când o cheie e greșită). */
  runStatus(projectId: string) {
    const runs = this.store.listRuns(projectId, 5);
    const last = runs[0] ? { ...runs[0] } : undefined;
    if (last && last.errors && !last.error) last.error = this.store.listResults(projectId, { runId: last.id }).find((r) => r.error)?.error;
    return { last, failed: !!last && last.errors > 0 && last.errors >= last.done, partial: !!last && last.errors > 0 && last.errors < last.done };
  }

  actions(projectId: string): { items: ActionView[]; progress: { done: number; total: number; byPriority: Record<string, { done: number; total: number }> }; insightsAt: string | null } {
    const p = this.store.getProject(projectId)!;
    const { metrics, sources, audit } = this.dashboard(projectId);
    const states = this.store.actionStates(projectId);
    const insight = this.store.listDocs<{ items: ActionItem[] }>('insights', projectId, 1)[0];
    const aiItems = insight?.data?.items ?? [];
    let items = [...aiItems, ...buildActions(p, audit, metrics.overall.n ? metrics : null, sources.rows)];
    const order = { P0: 0, P1: 1, P2: 2 };
    items.sort((a, b) => order[a.priority] - order[b.priority] || b.priorityScore - a.priorityScore);
    // Acțiunile deja închise rămân vizibile (istoric), chiar dacă problema nu mai apare.
    const keys = new Set(items.map((i) => i.key));
    const closedOrphans = [...states.values()].filter((s) => !keys.has(s.key) && (s.status === 'done' || s.status === 'verified'));
    const view: ActionView[] = items.map((i) => ({ ...i, state: states.get(i.key) ?? { key: i.key, status: 'todo', owner: '', evidenceUrl: '', note: '', due: '', updatedAt: '' } }));
    for (const s of closedOrphans) view.push({ key: s.key, category: 'technical', title: s.note || s.key.replace(/^\w+:/, ''), why: 'Rezolvat — problema nu mai apare în ultima analiză.', steps: [], acceptance: '', impact: 0, effort: 1, confidence: 0, gap: 0, priorityScore: 0, priority: 'P2', evidence: [], state: s });
    items = view;
    const isDone = (s: ActionStatus) => s === 'done' || s === 'verified';
    const byPriority: Record<string, { done: number; total: number }> = {};
    for (const v of view) {
      const b = (byPriority[v.priority] ??= { done: 0, total: 0 });
      b.total++;
      if (isDone(v.state.status)) b.done++;
    }
    return { items: view, progress: { done: view.filter((v) => isDone(v.state.status)).length, total: view.length, byPriority }, insightsAt: insight?.createdAt ?? null };
  }

  /** Recomandări AI construite din datele proiectului (ca „Actions” din Peec, dar cu pași și dovezi). */
  async insights(projectId: string): Promise<{ count: number; costUsd: number; error?: string }> {
    const p = this.store.getProject(projectId)!;
    const d = this.dashboard(projectId);
    const r = await generateInsights(p, d.metrics, d.analytics, d.sources.rows, d.audit, this.cfg);
    if (r.items.length) this.store.saveDoc('insights', uid('i_'), projectId, { items: r.items, costUsd: r.costUsd });
    return { count: r.items.length, costUsd: r.costUsd, error: r.error };
  }

  /** Optimizator de conținut: pagina ta vs. paginile pe care AI-ul le citează pentru aceeași întrebare. */
  async optimize(projectId: string, url: string, promptId?: string, question?: string): Promise<OptimizeResult> {
    const p = this.store.getProject(projectId)!;
    const prompt = promptId ? this.store.getPrompt(promptId) : null;
    const q = question?.trim() || prompt?.text || p.category || p.name;
    const rs = promptId ? this.store.listResults(projectId, { promptId }) : [];
    const counts = new Map<string, number>();
    rs.flatMap((r) => r.citations.filter((c) => c.kind === 'cited' && !sameSite(c.domain, p.domain) && !/vertexaisearch|maps\.google/.test(c.url))).forEach((c) => counts.set(c.url, (counts.get(c.url) ?? 0) + 1));
    const compUrls = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([u]) => u).slice(0, 3);
    const res = await optimizePage(p, url, q, compUrls, this.cfg);
    this.store.saveDoc('optimizations', uid('o_'), projectId, res);
    return res;
  }

  /** Analiza logurilor de acces (streaming, linie cu linie). */
  async analyzeLogs(projectId: string, lines: AsyncIterable<string>): Promise<LogReport> {
    const a = new LogAnalyzer();
    for await (const l of lines) a.push(l);
    const audit = this.store.latestAudit(projectId);
    const important = (audit?.pages ?? []).map((x) => {
      try {
        return new URL(x.url).pathname;
      } catch {
        return '';
      }
    }).filter(Boolean);
    const rep = a.report([...new Set(important)]);
    this.store.saveDoc('logreports', uid('l_'), projectId, rep);
    return rep;
  }

  setAction(projectId: string, key: string, patch: Partial<ActionState> & { title?: string }): ActionState {
    const cur = this.store.actionStates(projectId).get(key) ?? { key, status: 'todo' as ActionStatus, owner: '', evidenceUrl: '', note: '', due: '', updatedAt: '' };
    const next: ActionState = { ...cur, ...patch, key, note: patch.note ?? (cur.note || patch.title || ''), updatedAt: new Date().toISOString() };
    this.store.setActionState(projectId, next);
    return next;
  }

  generate(projectId: string, kind: GeneratorKind, arg?: string): Generated {
    const p = this.store.getProject(projectId)!;
    const { metrics, sources } = this.dashboard(projectId);
    return generate(kind, p, { prompts: this.store.listPrompts(projectId), metrics, sources: sources.rows as SourceRow[], arg });
  }

  // ── Programare: rulări săptămânale/zilnice + re-audit săptămânal.
  tick(): void {
    // Audituri făcute cu reguli vechi (texte/verificări depășite) → refăcute automat, o singură dată.
    for (const p of this.store.listProjects()) {
      if (p.demo || this.store.activeJobs(p.id).some((j) => j.type === 'audit')) continue;
      const a = this.store.latestAudit(p.id);
      if (a && (a.version ?? 0) < AUDIT_VERSION) {
        this.startAudit(p.id);
        this.log(`[audit] ${p.name}: audit refăcut cu regulile v${AUDIT_VERSION}`);
      } else if (a && !auditReadable(a) && Date.now() - Date.parse(a.finishedAt) > 6 * 3600000) {
        // Site blocat temporar (WAF / limită de cereri): reîncercăm rar, ca să nu prelungim blocarea.
        this.startAudit(p.id);
        this.log(`[audit] ${p.name}: reîncerc auditul (ultimul nu a putut citi site-ul)`);
      }
    }
    for (const p of this.store.listProjects()) {
      if (p.schedule === 'manual' || p.demo) continue;
      if (this.store.activeJobs(p.id).length) continue;
      const lastRun = this.store.listRuns(p.id, 1)[0];
      if (lastRun?.status === 'failed' && lastRun.error && /401|403|cheie|key/i.test(lastRun.error) && Date.now() - Date.parse(lastRun.createdAt) < 86400000) continue;
      const last = this.store.listRuns(p.id, 1)[0];
      const period = p.schedule === 'daily' ? 86400000 : 7 * 86400000;
      if (p.engines.length && (!last || Date.now() - Date.parse(last.createdAt) > period)) {
        try {
          this.startRun(p.id, { trigger: 'schedule' });
          this.log(`[schedule] rulare pornită pentru ${p.name}`);
        } catch (e) {
          this.log(`[schedule] ${p.name}: ${(e as Error).message}`);
        }
      }
      const la = this.store.lastJob(p.id, 'audit');
      if (!la || Date.now() - Date.parse(la.createdAt) > 7 * 86400000) this.startAudit(p.id);
    }
  }

  // ── Demo
  seedDemo(): Project {
    const p = this.createProject(
      {
        name: 'Pizzeria Forno Demo',
        domain: 'forno-demo.example',
        aliases: ['Forno Demo'],
        vertical: 'restaurant',
        category: 'pizzerie',
        categoryEn: 'pizzeria',
        city: 'Iași',
        region: 'Iași',
        neighborhoods: ['Copou', 'Tătărași', 'Păcurari', 'Centru'],
        services: ['pizza napoletană', 'pizza la domiciliu', 'pizza vegană'],
        topics: [{ name: 'Pizza napoletană' }, { name: 'Livrare pizza' }, { name: 'Pizza vegană' }, { name: 'Pizzerii pentru grupuri' }],
        personas: [
          { name: 'Student cu buget mic', description: 'Sunt student în Iași și caut ceva bun, dar ieftin.' },
          { name: 'Părinte cu copii', description: 'Am doi copii mici și caut un loc liniștit pentru familie.' },
          { name: 'Turist', description: 'Sunt în vizită în Iași pentru un weekend și vreau ceva autentic.' },
        ],
        scope: 'local',
        competitors: [
          { name: 'Pizzeria Exemplu Uno', domain: 'exemplu-uno.example' },
          { name: 'Napoli Express Demo' },
          { name: 'Bella Vista Demo' },
          { name: 'Il Forno Antico Demo' },
        ],
        languages: ['ro'],
        engines: ['chatgpt', 'gemini', 'perplexity', 'claude'],
        repetitions: 3,
        schedule: 'manual',
        facts: { address: 'Str. Exemplului 12', city: 'Iași', phone: '0700 123 456', hours: 'Mo-Su 11:00-23:00', priceRange: '35-70 lei', cuisine: 'italiană, pizza napoletană', description: 'Pizzerie napoletană demonstrativă, cu cuptor pe lemne.' },
        demo: true,
      },
      { promptCount: 14 },
    );
    // Istoric: 4 rulări săptămânale cu progres crescător (simulează implementarea acțiunilor).
    const prompts = this.store.listPrompts(p.id);
    const engines: EngineId[] = ['chatgpt', 'gemini', 'perplexity', 'claude'];
    [28, 21, 14, 7].forEach((daysAgo, wi) => {
      const runId = uid('run_');
      const at = new Date(Date.now() - daysAgo * 86400000);
      let n = 0;
      for (const q of prompts) for (const e of engines) for (let rep = 1; rep <= 2; rep++) {
        const persona = rep === 2 && q.intent !== 'brand' ? p.personas![(n + wi) % 3].name : undefined;
        const r = simulateAnswer(p, q.text, e, `${runId}|${rep}`, wi * 0.22);
        this.store.saveResult({ id: uid('r_'), projectId: p.id, runId, promptId: q.id, engine: e, model: r.model, rep, createdAt: new Date(at.getTime() + n * 1000).toISOString(), text: r.text, citations: r.citations, searchQueries: r.searchQueries, usage: r.usage, latencyMs: 5, simulated: true, persona, extraction: extract(r.text, r.citations, p) });
        n++;
      }
      this.store.createRun({ id: runId, projectId: p.id, createdAt: at.toISOString(), status: 'done', engines, total: n, done: n, errors: 0, costUsd: 0, trigger: 'demo' });
    });
    // Câteva acțiuni deja bifate, ca să se vadă progresul.
    for (const k of ['check:robots_ai_search', 'check:gbp_complete', 'check:sitemap']) this.setAction(p.id, k, { status: 'done', owner: 'Agenția', evidenceUrl: 'https://forno-demo.example' });
    this.setAction(p.id, 'check:bing_places', { status: 'in_progress', owner: 'Client' });
    // Audit demonstrativ (site-ul demo nu există, deci construim un audit sintetic din fixture).
    this.store.saveAudit(uid('a_'), p.id, demoAudit(p));
    return p;
  }
}

function demoProgress(store: Store, projectId: string): number {
  return Math.min(1, store.listRuns(projectId, 100).length * 0.2);
}

function demoAudit(p: Project): AuditResult {
  const f = (id: string, pillar: AuditResult['findings'][0]['pillar'], title: string, weight: number, status: AuditResult['findings'][0]['status'], detail: string, manual = false) => ({ id, pillar, title, weight, status, detail, evidence: [] as string[], manual });
  const findings = [
    f('home_https_200', 'access', 'Pagina principală răspunde 200 pe HTTPS', 3, 'pass', '200 OK în 420 ms.'),
    f('robots_ai_search', 'access', 'robots.txt permite crawlerele de căutare AI', 5, 'pass', 'Bifat după corectare (demo).'),
    f('waf_bots', 'access', 'Firewall/CDN nu blochează boții AI (test live)', 3, 'fail', 'Cererile cu user-agent PerplexityBot, Claude-SearchBot au primit 403 (demo).'),
    f('sitemap', 'access', 'Sitemap XML valid și declarat', 2, 'pass', '18 URL-uri în sitemap.'),
    f('server_rendered', 'access', 'Conținutul important e în HTML (nu doar după JavaScript)', 3, 'warn', 'Pagina /meniu pare goală fără JavaScript (demo).'),
    f('indexable', 'access', 'Paginile cheie nu au noindex și au canonical corect', 2, 'pass', 'Fără noindex.'),
    f('speed', 'access', 'Timp de răspuns acceptabil', 2, 'warn', 'Timp mediu 1450 ms.'),
    f('schema_business', 'entity', 'JSON-LD Organization/LocalBusiness prezent', 5, 'fail', 'Nu există date structurate despre business.'),
    f('schema_props', 'entity', 'Schema are proprietățile cheie (adresă, telefon, program, geo, preț)', 4, 'fail', 'Fără schema de business.'),
    f('sameas', 'entity', 'Profilurile oficiale sunt legate (sameAs + linkuri în site)', 2, 'warn', 'Linkuri spre Facebook și Instagram, fără sameAs.'),
    f('nap_consistent', 'entity', 'Nume, adresă și telefon consistente', 4, 'warn', 'Alte numere găsite: 232111222 (verificați).'),
    f('address_visible', 'entity', 'Adresa și zona deservită sunt vizibile în text', 2, 'warn', 'Adresă găsită. Cartiere menționate: niciunul.'),
    f('about_page', 'entity', 'Pagină „Despre” cu fapte verificabile', 3, 'warn', '/despre: 90 cuvinte, 1 fapt numeric.'),
    f('titles_meta', 'content', 'Title și meta description clare (categorie + oraș)', 3, 'warn', 'Orașul nu apare în title.'),
    f('h1', 'content', 'Un H1 clar pe fiecare pagină', 2, 'pass', 'OK.'),
    f('service_pages', 'content', 'Pagini dedicate pentru fiecare serviciu / caz de utilizare', 5, 'fail', 'Fără pagină dedicată: pizza vegană, livrare pizza.'),
    f('faq', 'content', 'Întrebări reale cu răspuns direct (FAQ / titluri-întrebare)', 4, 'fail', 'Nicio întrebare formulată ca titlu.'),
    f('menu_prices_text', 'content', 'Meniu / prețuri ca text HTML (nu doar PDF sau poză)', 4, 'fail', 'Meniul pare să fie doar în PDF.'),
    f('fact_density', 'content', 'Fapte și cifre citabile', 3, 'warn', '6 fapte numerice (2,1/1000 cuvinte).'),
    f('freshness', 'content', 'Semnale de actualitate', 2, 'warn', 'Puține pagini indică data actualizării.'),
    f('trust_signals', 'content', 'Dovezi: recenzii, studii de caz, autori/experți', 2, 'warn', 'Semnale slabe: recenzii.'),
    f('gbp_complete', 'offsite', 'Google Business Profile complet și verificat', 4, 'manual', '', true),
    f('bing_places', 'offsite', 'Bing Places revendicat și identic cu GBP', 3, 'manual', '', true),
    f('directories', 'offsite', 'Profiluri consistente în directoare', 3, 'manual', '', true),
    f('cited_sources_presence', 'offsite', 'Brandul apare pe sursele terțe pe care le citează AI-ul', 5, 'na', ''),
    f('reviews', 'offsite', 'Recenzii autentice: volum constant, recente, cu răspuns', 3, 'manual', '', true),
    f('press_mentions', 'offsite', 'Mențiuni în presă locală, ghiduri, liste „top”', 2, 'manual', '', true),
    f('baseline_engines', 'visibility', 'Baseline rulat pe minimum 3 motoare AI', 3, 'na', ''),
    f('visibility_rate', 'visibility', 'Rata de vizibilitate pe prompturile comerciale', 5, 'na', ''),
    f('citation_rate', 'visibility', 'Site-ul propriu este citat ca sursă', 3, 'na', ''),
    f('ai_accuracy', 'visibility', 'AI-ul redă corect datele business-ului', 2, 'na', ''),
    f('ga4_ai_channel', 'visibility', 'GA4: canal „AI Traffic” + evenimente de conversie', 2, 'manual', '', true),
    f('llms_txt', 'visibility', 'llms.txt (opțional, impact neconfirmat)', 0, 'warn', 'Nu există llms.txt.'),
  ];
  const now = new Date(Date.now() - 27 * 86400000).toISOString();
  return {
    url: `https://${p.domain}`, startedAt: now, finishedAt: now, pagesCrawled: 12,
    ...scoreFindings(findings),
    findings,
    pages: [],
    bots: [
      { token: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search', robotsAllowed: true, liveStatus: 200, liveBlocked: false },
      { token: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search', robotsAllowed: true, liveStatus: 403, liveBlocked: true },
      { token: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', robotsAllowed: true, liveStatus: 403, liveBlocked: true },
      { token: 'Googlebot', operator: 'Google', purpose: 'search', robotsAllowed: true, liveStatus: 200, liveBlocked: false },
      { token: 'Bingbot', operator: 'Microsoft', purpose: 'search', robotsAllowed: true, liveStatus: 200, liveBlocked: false },
      { token: 'GPTBot', operator: 'OpenAI', purpose: 'training', robotsAllowed: false, robotsLine: 'linia 4: Disallow: /', liveStatus: 200, liveBlocked: false },
    ],
    notes: ['Audit demonstrativ — site-ul demo nu există. Rulați „Audit nou” pe un proiect real.'],
  };
}

function summarizeErrors(m: Map<EngineId, string>): string | undefined {
  if (!m.size) return undefined;
  return [...m.entries()].map(([e, err]) => `${e}: ${err}`).join(' | ').slice(0, 600);
}
