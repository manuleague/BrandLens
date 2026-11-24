// Stocare: SQLite (node:sqlite, inclus în Node ≥ 22.13) în mod WAL. Un singur fișier, zero dependențe.
// Pentru SaaS multi-tenant la scară: aceeași schemă se mută 1:1 pe PostgreSQL (vezi docs/ARCHITECTURE.md).

import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { ActionStatus, AuditResult, PromptDef, Project, StoredResult } from '../core/types.ts';

export interface ActionState {
  key: string;
  status: ActionStatus;
  owner: string;
  evidenceUrl: string;
  note: string;
  due: string;
  updatedAt: string;
}

export interface RunRow {
  id: string;
  projectId: string;
  createdAt: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  engines: string[];
  total: number;
  done: number;
  errors: number;
  costUsd: number;
  trigger: string;
  error?: string;
}

export interface JobRow {
  id: string;
  type: 'run' | 'audit' | 'setup' | 'analyze';
  projectId: string;
  payload: any;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  error: string | null;
  createdAt: string;
}

const j = (v: unknown) => JSON.stringify(v ?? null);
const pj = <T>(s: unknown, d: T): T => {
  try {
    return s == null ? d : (JSON.parse(String(s)) as T);
  } catch {
    return d;
  }
};

export class Store {
  db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS prompts (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        text TEXT NOT NULL, lang TEXT NOT NULL, intent TEXT NOT NULL, tags TEXT, active INTEGER NOT NULL DEFAULT 1);
      CREATE INDEX IF NOT EXISTS ix_prompts_project ON prompts(project_id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL, status TEXT NOT NULL, engines TEXT, total INTEGER, done INTEGER DEFAULT 0,
        errors INTEGER DEFAULT 0, cost REAL DEFAULT 0, trigger TEXT);
      CREATE TABLE IF NOT EXISTS results (
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, run_id TEXT NOT NULL,
        prompt_id TEXT NOT NULL, engine TEXT NOT NULL, model TEXT, rep INTEGER, created_at TEXT NOT NULL,
        text TEXT, citations TEXT, search_queries TEXT, usage TEXT, latency_ms INTEGER, error TEXT,
        simulated INTEGER DEFAULT 0, extraction TEXT);
      CREATE INDEX IF NOT EXISTS ix_results_project ON results(project_id, created_at);
      CREATE INDEX IF NOT EXISTS ix_results_run ON results(run_id);
      CREATE TABLE IF NOT EXISTS audits (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, score INTEGER, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS actions (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, key TEXT NOT NULL, status TEXT NOT NULL,
        owner TEXT DEFAULT '', evidence_url TEXT DEFAULT '', note TEXT DEFAULT '', due TEXT DEFAULT '', updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, key));
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, type TEXT NOT NULL, project_id TEXT NOT NULL, payload TEXT, status TEXT NOT NULL,
        attempts INTEGER DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status, created_at);
      CREATE TABLE IF NOT EXISTS insights (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS logreports (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS optimizations (id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE, created_at TEXT NOT NULL, data TEXT NOT NULL);
    `);
    this.migrate();
  }

  /** Migrări aditive: coloane noi pe baze create de versiunile anterioare. */
  private migrate(): void {
    const add = (table: string, col: string, def: string) => {
      const cols = (this.db.prepare(`PRAGMA table_info(${table})`).all() as any[]).map((c) => c.name);
      if (!cols.includes(col)) this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
    };
    add('prompts', 'topic', 'TEXT');
    add('prompts', 'stage', 'TEXT');
    add('prompts', 'origin', 'TEXT');
    add('results', 'persona', 'TEXT');
    add('runs', 'error', 'TEXT');
  }

  // ── Documente JSON pe proiect (insights, rapoarte de loguri, optimizări)
  saveDoc(table: 'insights' | 'logreports' | 'optimizations', id: string, projectId: string, data: unknown): void {
    this.db.prepare(`INSERT OR REPLACE INTO ${table} (id, project_id, created_at, data) VALUES (?, ?, ?, ?)`).run(id, projectId, new Date().toISOString(), j(data));
  }
  listDocs<T>(table: 'insights' | 'logreports' | 'optimizations', projectId: string, limit = 20): { id: string; createdAt: string; data: T }[] {
    return this.db.prepare(`SELECT * FROM ${table} WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`).all(projectId, limit).map((r: any) => ({ id: r.id, createdAt: r.created_at, data: pj<T>(r.data, null as T) }));
  }

  // ── Proiecte
  listProjects(): Project[] {
    return this.db.prepare('SELECT data FROM projects ORDER BY created_at DESC').all().map((r: any) => pj<Project>(r.data, {} as Project));
  }
  getProject(id: string): Project | null {
    const r: any = this.db.prepare('SELECT data FROM projects WHERE id = ?').get(id);
    return r ? pj<Project>(r.data, null as unknown as Project) : null;
  }
  getProjectByToken(token: string): Project | null {
    return this.listProjects().find((p) => p.shareToken === token) ?? null;
  }
  saveProject(p: Project): void {
    this.db.prepare('INSERT INTO projects (id, data, created_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data').run(p.id, j(p), p.createdAt);
  }
  deleteProject(id: string): void {
    this.db.prepare('DELETE FROM projects WHERE id = ?').run(id);
    this.db.prepare('DELETE FROM jobs WHERE project_id = ?').run(id);
  }

  // ── Prompturi
  listPrompts(projectId: string): PromptDef[] {
    return this.db.prepare('SELECT * FROM prompts WHERE project_id = ? ORDER BY rowid').all(projectId).map((r: any) => this.mapPrompt(r));
  }
  private mapPrompt(r: any): PromptDef {
    return { id: r.id, projectId: r.project_id, text: r.text, lang: r.lang, intent: r.intent, tags: pj<string[]>(r.tags, []), active: !!r.active, topic: r.topic ?? undefined, stage: r.stage ?? undefined, origin: r.origin ?? undefined };
  }
  savePrompt(p: PromptDef): void {
    this.db.prepare(`INSERT INTO prompts (id, project_id, text, lang, intent, tags, active, topic, stage, origin) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET text = excluded.text, lang = excluded.lang, intent = excluded.intent, tags = excluded.tags, active = excluded.active, topic = excluded.topic, stage = excluded.stage, origin = excluded.origin`)
      .run(p.id, p.projectId, p.text, p.lang, p.intent, j(p.tags), p.active ? 1 : 0, p.topic ?? null, p.stage ?? null, p.origin ?? null);
  }
  getPrompt(id: string): PromptDef | null {
    const r: any = this.db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    return r ? this.mapPrompt(r) : null;
  }
  deletePrompt(id: string): void {
    this.db.prepare('DELETE FROM prompts WHERE id = ?').run(id);
  }

  // ── Rulări
  createRun(r: RunRow): void {
    this.db.prepare('INSERT INTO runs (id, project_id, created_at, status, engines, total, done, errors, cost, trigger) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(r.id, r.projectId, r.createdAt, r.status, j(r.engines), r.total, r.done, r.errors, r.costUsd, r.trigger);
  }
  updateRun(id: string, patch: Partial<Pick<RunRow, 'status' | 'done' | 'errors' | 'costUsd' | 'error'>>): void {
    const cur = this.getRun(id);
    if (!cur) return;
    const n = { ...cur, ...patch };
    this.db.prepare('UPDATE runs SET status = ?, done = ?, errors = ?, cost = ?, error = ? WHERE id = ?').run(n.status, n.done, n.errors, n.costUsd, n.error ?? null, id);
  }
  getRun(id: string): RunRow | null {
    const r: any = this.db.prepare('SELECT * FROM runs WHERE id = ?').get(id);
    return r ? this.mapRun(r) : null;
  }
  listRuns(projectId: string, limit = 50): RunRow[] {
    return this.db.prepare('SELECT * FROM runs WHERE project_id = ? ORDER BY created_at DESC LIMIT ?').all(projectId, limit).map((r: any) => this.mapRun(r));
  }
  private mapRun(r: any): RunRow {
    return { id: r.id, projectId: r.project_id, createdAt: r.created_at, status: r.status, engines: pj(r.engines, []), total: r.total, done: r.done, errors: r.errors, costUsd: r.cost, trigger: r.trigger, error: r.error ?? undefined };
  }

  // ── Rezultate
  saveResult(r: StoredResult): void {
    this.db.prepare(`INSERT OR REPLACE INTO results (id, project_id, run_id, prompt_id, engine, model, rep, created_at, text, citations, search_queries, usage, latency_ms, error, simulated, extraction, persona)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(r.id, r.projectId, r.runId, r.promptId, r.engine, r.model, r.rep, r.createdAt, r.text, j(r.citations), j(r.searchQueries), j(r.usage), r.latencyMs, r.error ?? null, r.simulated ? 1 : 0, j(r.extraction), r.persona ?? null);
  }
  updateExtraction(id: string, ex: unknown, usage: unknown): void {
    this.db.prepare('UPDATE results SET extraction = ?, usage = ? WHERE id = ?').run(j(ex), j(usage), id);
  }
  listResults(projectId: string, opts: { sinceDays?: number; promptId?: string; runId?: string } = {}): StoredResult[] {
    const where = ['project_id = ?'];
    const args: (string | number)[] = [projectId];
    if (opts.sinceDays) {
      where.push('created_at >= ?');
      args.push(new Date(Date.now() - opts.sinceDays * 86400000).toISOString());
    }
    if (opts.promptId) {
      where.push('prompt_id = ?');
      args.push(opts.promptId);
    }
    if (opts.runId) {
      where.push('run_id = ?');
      args.push(opts.runId);
    }
    return this.db.prepare(`SELECT * FROM results WHERE ${where.join(' AND ')} ORDER BY created_at`).all(...args).map((r: any) => ({
      id: r.id, projectId: r.project_id, runId: r.run_id, promptId: r.prompt_id, engine: r.engine, model: r.model, rep: r.rep, createdAt: r.created_at,
      text: r.text ?? '', citations: pj(r.citations, []), searchQueries: pj(r.search_queries, []), usage: pj(r.usage, {}), latencyMs: r.latency_ms,
      error: r.error ?? undefined, simulated: !!r.simulated, extraction: pj(r.extraction, null as any), persona: r.persona ?? undefined,
    }));
  }
  resultKeysForRun(runId: string): Set<string> {
    return new Set(this.db.prepare('SELECT prompt_id, engine, rep, persona FROM results WHERE run_id = ?').all(runId).map((r: any) => `${r.prompt_id}|${r.engine}|${r.rep}|${r.persona ?? ''}`));
  }

  // ── Audituri
  saveAudit(id: string, projectId: string, a: AuditResult): void {
    this.db.prepare('INSERT INTO audits (id, project_id, created_at, score, data) VALUES (?, ?, ?, ?, ?)').run(id, projectId, a.finishedAt, a.score, j(a));
  }
  /** Ultimul audit; cu readable=true, ultimul în care site-ul a putut fi citit (un audit blocat de WAF nu înlocuiește unul bun). */
  latestAudit(projectId: string, opts: { readable?: boolean } = {}): AuditResult | null {
    const rows: any[] = this.db.prepare(`SELECT data FROM audits WHERE project_id = ? ORDER BY created_at DESC LIMIT ${opts.readable ? 30 : 1}`).all(projectId);
    for (const r of rows) {
      const a = pj<AuditResult | null>(r.data, null);
      if (a && (!opts.readable || auditReadable(a))) return a;
    }
    return null;
  }
  auditHistory(projectId: string): { createdAt: string; score: number }[] {
    return this.db.prepare('SELECT created_at, score, data FROM audits WHERE project_id = ? ORDER BY created_at').all(projectId)
      .filter((r: any) => auditReadable(pj<AuditResult>(r.data, {} as AuditResult)))
      .map((r: any) => ({ createdAt: r.created_at, score: r.score }));
  }

  // ── Acțiuni (starea e separată de recomandare, ca re-generarea să nu piardă bifele)
  actionStates(projectId: string): Map<string, ActionState> {
    const m = new Map<string, ActionState>();
    for (const r of this.db.prepare('SELECT * FROM actions WHERE project_id = ?').all(projectId) as any[]) {
      m.set(r.key, { key: r.key, status: r.status, owner: r.owner, evidenceUrl: r.evidence_url, note: r.note, due: r.due, updatedAt: r.updated_at });
    }
    return m;
  }
  setActionState(projectId: string, s: ActionState): void {
    this.db.prepare(`INSERT INTO actions (project_id, key, status, owner, evidence_url, note, due, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(project_id, key) DO UPDATE SET status = excluded.status, owner = excluded.owner, evidence_url = excluded.evidence_url, note = excluded.note, due = excluded.due, updated_at = excluded.updated_at`)
      .run(projectId, s.key, s.status, s.owner, s.evidenceUrl, s.note, s.due, s.updatedAt);
  }

  // ── Coadă de joburi (persistentă; reluare după restart)
  enqueue(job: Omit<JobRow, 'status' | 'attempts' | 'error' | 'createdAt'>): void {
    const now = new Date().toISOString();
    this.db.prepare('INSERT INTO jobs (id, type, project_id, payload, status, attempts, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 0, NULL, ?, ?)')
      .run(job.id, job.type, job.projectId, j(job.payload), 'queued', now, now);
  }
  claimJob(types: string[] = ['run', 'audit', 'setup', 'analyze']): JobRow | null {
    if (!types.length) return null;
    const r: any = this.db.prepare(`SELECT * FROM jobs WHERE status = 'queued' AND type IN (${types.map(() => '?').join(',')}) ORDER BY created_at LIMIT 1`).get(...types);
    if (!r) return null;
    const res = this.db.prepare("UPDATE jobs SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'").run(new Date().toISOString(), r.id);
    if (!res.changes) return null;
    return { id: r.id, type: r.type, projectId: r.project_id, payload: pj(r.payload, {}), status: 'running', attempts: r.attempts + 1, error: null, createdAt: r.created_at };
  }
  finishJob(id: string, status: 'done' | 'failed' | 'queued', error?: string): void {
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error ?? null, new Date().toISOString(), id);
  }
  requeueStale(): number {
    return Number(this.db.prepare("UPDATE jobs SET status = 'queued' WHERE status = 'running'").run().changes);
  }
  activeJobs(projectId: string): JobRow[] {
    return this.db.prepare("SELECT * FROM jobs WHERE project_id = ? AND status IN ('queued','running') ORDER BY created_at").all(projectId).map((r: any) => ({
      id: r.id, type: r.type, projectId: r.project_id, payload: pj(r.payload, {}), status: r.status, attempts: r.attempts, error: r.error, createdAt: r.created_at,
    }));
  }
  lastJob(projectId: string, type: string): JobRow | null {
    const r: any = this.db.prepare('SELECT * FROM jobs WHERE project_id = ? AND type = ? ORDER BY created_at DESC LIMIT 1').get(projectId, type);
    return r ? { id: r.id, type: r.type, projectId: r.project_id, payload: pj(r.payload, {}), status: r.status, attempts: r.attempts, error: r.error, createdAt: r.created_at } : null;
  }
}

/** Auditul a citit site-ul (și cele vechi, fără marcaj, în care pagina principală a dat eroare sunt excluse). */
export function auditReadable(a: AuditResult): boolean {
  if (!a?.findings) return false;
  if (a.unreadable) return false;
  return a.findings.find((f) => f.id === 'home_https_200')?.status !== 'fail';
}
