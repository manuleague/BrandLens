// Server HTTP (node:http, fără framework): API JSON + interfața web statică + worker de joburi + programator.

import { readFileSync, existsSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createInterface } from 'node:readline';
import { createGunzip } from 'node:zlib';
import { extname, join, normalize as normPath } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PILLAR_LABEL } from '../core/audit.ts';
import { ENGINE_LABEL } from '../core/engines.ts';
import { SOURCE_GROUP_LABEL, SOURCE_TYPE_LABEL } from '../core/sources.ts';
import type { EngineId, GeneratorKind, Project, PromptDef } from '../core/types.ts';
import { uid } from '../core/util.ts';
import { Store } from './db.ts';
import { renderReport } from './report.ts';
import { Service } from './service.ts';

loadDotEnv();

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const WEB = join(ROOT, 'web');
const PORT = Number(process.env.PORT || 4321);
const HOST = process.env.HOST || '127.0.0.1';
const PASSWORD = process.env.BRANDLENS_PASSWORD || '';

const store = new Store(process.env.DB_PATH || join(ROOT, 'data', 'brandlens.db'));
const svc = new Service(store);

function loadDotEnv(): void {
  const f = fileURLToPath(new URL('../../.env', import.meta.url));
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, 'utf8').replace(/^\uFEFF/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#') || process.env[m[1]] !== undefined) continue;
    let v = m[2];
    if (/^["']/.test(v)) v = v.replace(/^(["'])(.*)\1.*$/, '$2');
    else v = v.replace(/\s+#.*$/, '').trim(); // comentariu la final de linie
    process.env[m[1]] = v;
  }
}

// ── Router minimal
type Handler = (req: IncomingMessage, params: Record<string, string>, body: any, url: URL) => Promise<unknown> | unknown;
const routes: { method: string; re: RegExp; keys: string[]; h: Handler }[] = [];
function route(method: string, path: string, h: Handler) {
  const keys: string[] = [];
  const re = new RegExp('^' + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), '([^/]+)')) + '$');
  routes.push({ method, re, keys, h });
}
class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}
const need = <T>(v: T | null | undefined, msg = 'Nu există'): T => {
  if (v == null) throw new HttpError(404, msg);
  return v;
};

// ── API
route('GET', '/api/health', () => ({ ok: true, version: '0.1.0' }));
route('GET', '/api/meta', () => ({ engines: svc.engines(), engineLabels: ENGINE_LABEL, pillarLabels: PILLAR_LABEL, sourceTypeLabels: SOURCE_TYPE_LABEL, sourceGroupLabels: SOURCE_GROUP_LABEL, judge: svc.useJudge, analysis: svc.analysisInfo() }));
route('POST', '/api/engines/test', async () => ({ results: await svc.testEngines(), analysis: svc.analysisInfo() }));
route('POST', '/api/profile', async (_r, _p, body) => {
  if (!body?.domain) throw new HttpError(400, 'Introduceți domeniul.');
  return svc.profile(String(body.domain));
});

route('GET', '/api/projects', () =>
  store.listProjects().map((p) => {
    const d = svc.dashboard(p.id);
    return { ...p, kpi: { visibility: d.metrics.overall.visibility, n: d.metrics.overall.n, score: d.audit?.score ?? null, lastRunAt: d.metrics.lastRunAt } };
  }),
);
route('POST', '/api/projects', (_r, _p, body) => {
  if (!body?.name || !body?.domain) throw new HttpError(400, 'Numele și domeniul sunt obligatorii.');
  const p = svc.createProject(body, { aiSetup: body.aiPrompts !== false });
  if (body.autoAudit !== false) svc.startAudit(p.id);
  // Cu LLM: rularea pornește după ce jobul „setup” generează prompturile; fără LLM, imediat.
  if (body.autoRun && p.engines.length) {
    const setup = store.activeJobs(p.id).find((j) => j.type === 'setup');
    if (setup) {
      store.finishJob(setup.id, 'done');
      store.enqueue({ id: uid('j_'), type: 'setup', projectId: p.id, payload: { perTopic: 4, thenRun: true } });
    } else svc.startRun(p.id, { trigger: 'onboarding' });
  }
  return p;
});
route('POST', '/api/demo', () => svc.seedDemo());
route('GET', '/api/projects/:id', (_r, { id }) => need(store.getProject(id)));
route('PUT', '/api/projects/:id', (_r, { id }, body) => need(svc.updateProject(id, body as Partial<Project>)));
route('DELETE', '/api/projects/:id', (_r, { id }) => (store.deleteProject(id), { ok: true }));

route('GET', '/api/projects/:id/dashboard', (_r, { id }, _b, url) => {
  need(store.getProject(id));
  const days = Number(url.searchParams.get('days') || 30);
  const d = svc.dashboard(id, days);
  return { metrics: d.metrics, analytics: d.analytics, sources: { ...d.sources, rows: d.sources.rows.slice(0, 80) }, audit: d.audit, auditBlocked: d.auditBlocked, auditHistory: store.auditHistory(id), runs: store.listRuns(id, 20), runStatus: svc.runStatus(id), jobs: store.activeJobs(id), actions: svc.actions(id).progress, analysis: svc.analysisInfo() };
});

route('GET', '/api/projects/:id/prompts', (_r, { id }) => store.listPrompts(id));
route('POST', '/api/projects/:id/prompts', (_r, { id }, body) => {
  need(store.getProject(id));
  const texts: string[] = Array.isArray(body?.texts) ? body.texts : [body?.text];
  const out: PromptDef[] = [];
  for (const t of texts.map((x) => String(x ?? '').trim()).filter(Boolean)) {
    const q: PromptDef = { id: uid('q_'), projectId: id, text: t, lang: body.lang ?? 'ro', intent: body.intent ?? 'category', tags: body.tags ?? (body.topic ? [body.topic] : []), active: true, topic: body.topic, origin: 'manual' };
    store.savePrompt(q);
    out.push(q);
  }
  return out;
});
route('POST', '/api/projects/:id/prompts/generate', (_r, { id }, body) => svc.regeneratePrompts(id, !!body?.replace));
route('POST', '/api/projects/:id/prompts/ai', async (_r, { id }, body) => svc.aiPrompts(id, { perTopic: Number(body?.perTopic) || 4, topics: body?.topics, replaceTemplates: !!body?.replaceTemplates }));
route('POST', '/api/projects/:id/reanalyze', (_r, { id }) => ({ jobId: svc.startReanalyze(id) }));
route('POST', '/api/projects/:id/insights', async (_r, { id }) => svc.insights(id));
route('POST', '/api/projects/:id/optimize', async (_r, { id }, body) => {
  if (!body?.url) throw new HttpError(400, 'Introduceți URL-ul paginii.');
  return svc.optimize(id, String(body.url), body.promptId, body.question);
});
route('GET', '/api/projects/:id/optimizations', (_r, { id }) => store.listDocs('optimizations', id, 10));
route('GET', '/api/projects/:id/logs', (_r, { id }) => store.listDocs('logreports', id, 5));
route('PUT', '/api/prompts/:pid', (_r, { pid }, body) => {
  const q = need(store.getPrompt(pid));
  const n = { ...q, ...body, id: q.id, projectId: q.projectId };
  store.savePrompt(n);
  return n;
});
route('DELETE', '/api/prompts/:pid', (_r, { pid }) => (store.deletePrompt(pid), { ok: true }));

route('POST', '/api/projects/:id/runs', (_r, { id }, body) => {
  try {
    return { runId: svc.startRun(id, { engines: body?.engines as EngineId[], repetitions: body?.repetitions, promptIds: body?.promptIds }) };
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
});
route('GET', '/api/projects/:id/runs', (_r, { id }) => store.listRuns(id));
route('GET', '/api/projects/:id/results', (_r, { id }, _b, url) =>
  store.listResults(id, { promptId: url.searchParams.get('promptId') ?? undefined, sinceDays: Number(url.searchParams.get('days') || 90) }).reverse().slice(0, 200),
);

route('POST', '/api/projects/:id/audit', (_r, { id }, body) => ({ jobId: svc.startAudit(id, body?.maxPages) }));
route('GET', '/api/projects/:id/audit', (_r, { id }) => svc.dashboard(id).audit);

route('GET', '/api/projects/:id/actions', (_r, { id }) => svc.actions(id));
route('PUT', '/api/projects/:id/actions', (_r, { id }, body) => {
  if (!body?.key) throw new HttpError(400, 'key lipsă');
  return svc.setAction(id, body.key, body);
});
route('POST', '/api/projects/:id/generate/:kind', (_r, { id, kind }, body) => svc.generate(id, kind as GeneratorKind, body?.arg));

route('GET', '/api/projects/:id/export.csv', (_r, { id }) => {
  const rows = store.listResults(id);
  const prompts = new Map(store.listPrompts(id).map((q) => [q.id, q]));
  const q = (s: unknown) => `"${String(s ?? '').replace(/"/g, '""')}"`;
  const lines = ['date,engine,model,prompt,intent,rep,mentioned,position,recommended,sentiment,cited_own,competitors,citations,error'];
  for (const r of rows) {
    const e = r.extraction;
    lines.push([r.createdAt, r.engine, r.model, q(prompts.get(r.promptId)?.text), prompts.get(r.promptId)?.intent, r.rep, e.ownMentioned ? 1 : 0, e.ownPosition ?? '', e.ownRecommended ? 1 : 0, e.ownSentiment?.toFixed(1) ?? '', e.ownCited ? 1 : 0, q(e.mentions.filter((m) => !m.own).map((m) => m.brand).join('; ')), q(r.citations.filter((c) => c.kind === 'cited').map((c) => c.url).join(' ')), q(r.error)].join(','));
  }
  return { __raw: lines.join('\n'), type: 'text/csv; charset=utf-8', filename: `brandlens-${id}.csv` };
});

route('GET', '/api/projects/:id/report', (_r, { id }, _b, url) => ({ __raw: renderReport(svc, need(store.getProject(id)).id, Number(url.searchParams.get('days') || 30)), type: 'text/html; charset=utf-8' }));

// ── HTTP
const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png' };

function authorized(req: IncomingMessage): boolean {
  if (!PASSWORD) return true;
  const h = req.headers.authorization ?? '';
  if (!h.startsWith('Basic ')) return false;
  const [, pass] = Buffer.from(h.slice(6), 'base64').toString().split(':');
  return pass === PASSWORD;
}

async function readBody(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += (c as Buffer).length;
    if (size > 2_000_000) throw new HttpError(413, 'Body prea mare');
    chunks.push(c as Buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'JSON invalid');
  }
}

function send(res: ServerResponse, status: number, data: unknown) {
  if (data && typeof data === 'object' && '__raw' in (data as any)) {
    const d = data as { __raw: string; type: string; filename?: string };
    res.writeHead(status, { 'content-type': d.type, ...(d.filename ? { 'content-disposition': `attachment; filename="${d.filename}"` } : {}) });
    res.end(d.__raw);
    return;
  }
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(data));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
  res.setHeader('x-content-type-options', 'nosniff');
  res.setHeader('referrer-policy', 'no-referrer');
  try {
    // Raport public (link partajabil, fără autentificare).
    const pub = url.pathname.match(/^\/r\/([\w-]+)$/);
    if (pub) {
      const p = store.getProjectByToken(pub[1]);
      if (!p) return send(res, 404, { error: 'Raport inexistent' });
      return send(res, 200, { __raw: renderReport(svc, p.id), type: 'text/html; charset=utf-8' });
    }
    // Upload de loguri: streaming linie cu linie (fișiere de sute de MB), în afara limitei de body JSON.
    const logUp = url.pathname.match(/^\/api\/projects\/([\w-]+)\/logs$/);
    if (logUp && req.method === 'POST') {
      if (!authorized(req)) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="BrandLens"' });
        return res.end('Autentificare necesară');
      }
      if (!store.getProject(logUp[1])) return send(res, 404, { error: 'Proiect inexistent' });
      const gz = /gzip/.test(String(req.headers['content-encoding'] ?? '')) || url.searchParams.get('gz') === '1';
      const input = gz ? req.pipe(createGunzip()) : req;
      const rl = createInterface({ input, crlfDelay: Infinity });
      return send(res, 200, await svc.analyzeLogs(logUp[1], rl));
    }
    if (url.pathname !== '/api/health' && !authorized(req)) {
      res.writeHead(401, { 'www-authenticate': 'Basic realm="BrandLens"' });
      return res.end('Autentificare necesară');
    }
    if (url.pathname.startsWith('/api/')) {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.re);
        if (!m) continue;
        const params = Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])]));
        const body = req.method === 'GET' || req.method === 'DELETE' ? {} : await readBody(req);
        return send(res, 200, await r.h(req, params, body, url));
      }
      return send(res, 404, { error: 'Rută inexistentă' });
    }
    // Fișiere statice
    let file = normPath(join(WEB, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(WEB) || !existsSync(file)) file = join(WEB, 'index.html');
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error(e);
    send(res, status, { error: (e as Error).message });
  }
});

// ── Worker: procesează joburile din coadă (rulări de prompturi, audituri), unul câte unul per tip.
const busy: Record<'run' | 'audit' | 'setup' | 'analyze', boolean> = { run: false, audit: false, setup: false, analyze: false };
async function workLoop() {
  for (let i = 0; i < 4; i++) {
    const job = store.claimJob((['run', 'audit', 'setup', 'analyze'] as const).filter((t) => !busy[t]));
    if (!job) return;
    busy[job.type] = true;
    (async () => {
      try {
        if (job.type === 'run') await svc.processRun(job);
        else if (job.type === 'audit') await svc.processAudit(job);
        else if (job.type === 'setup') await svc.processSetup(job);
        else await svc.processAnalyze(job);
        store.finishJob(job.id, 'done');
      } catch (e) {
        console.error(`[job ${job.type}]`, e);
        store.finishJob(job.id, job.attempts < 3 ? 'queued' : 'failed', (e as Error).message);
        if (job.type === 'run' && job.attempts >= 3) store.updateRun(job.payload.runId, { status: 'failed' });
      } finally {
        busy[job.type] = false;
      }
    })();
  }
}

const requeued = store.requeueStale();
if (requeued) console.log(`[worker] ${requeued} joburi reluate după restart`);
setInterval(workLoop, 1000);
setInterval(() => svc.tick(), 60_000);
setTimeout(() => svc.tick(), 5_000);
// Verificare rapidă a cheilor la pornire: scrie în consolă exact ce motor nu funcționează și de ce.
setTimeout(async () => {
  try {
    const t = await svc.testEngines();
    for (const [e, r] of Object.entries(t)) if (r.configured) console.log(`  ${r.ok ? '✓' : '✗'} ${ENGINE_LABEL[e as EngineId]} (${r.model})${r.ok ? '' : ` — ${r.error}${r.hint ? `. ${r.hint}` : ''}`}`);
    const a = svc.analysisInfo();
    console.log(a.enabled ? `  Analiză AI: ${a.provider} / ${a.model}` : '  Analiză AI: dezactivată (nicio cheie validă) — se folosesc regulile deterministe.');
  } catch (err) {
    console.error(err);
  }
}, 1500);

server.listen(PORT, HOST, () => {
  const eng = Object.entries(svc.engines()).filter(([e, s]) => s.configured && e !== 'simulator').map(([e]) => ENGINE_LABEL[e as EngineId]);
  console.log(`\n  BrandLens rulează pe http://${HOST}:${PORT}`);
  console.log(`  Motoare AI configurate: ${eng.length ? eng.join(', ') : 'niciunul (folosiți proiectul demo sau completați .env)'}`);
  console.log(`  Bază de date: ${process.env.DB_PATH || join(ROOT, 'data', 'brandlens.db')}${PASSWORD ? '\n  Autentificare: activă' : ''}\n`);
});
