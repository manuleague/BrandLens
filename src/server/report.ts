import { isLocal } from '../core/prompts.ts';
// Raport client (HTML server-side, printabil ca PDF). Accesibil prin link public cu token, fără cont.

import { PILLAR_LABEL } from '../core/audit.ts';
import { ENGINE_LABEL } from '../core/engines.ts';
import { SOURCE_TYPE_LABEL } from '../core/sources.ts';
import type { EngineId, Pillar } from '../core/types.ts';
import type { Service } from './service.ts';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export function renderReport(svc: Service, projectId: string, days = 30): string {
  const p = svc.store.getProject(projectId)!;
  const { metrics: m, analytics: a, sources, audit } = svc.dashboard(projectId, days);
  const own = a.brands.find((b) => b.own);
  const acts = svc.actions(projectId);
  const hist = svc.store.auditHistory(projectId);
  const runs = svc.store.listRuns(projectId, 100);
  const engines = Object.entries(m.byEngine) as [EngineId, NonNullable<(typeof m.byEngine)[EngineId]>][];
  const first = m.trend.find((t) => t.engine === 'all');
  const last = [...m.trend].reverse().find((t) => t.engine === 'all');
  const doneActs = acts.items.filter((a) => a.state.status === 'done' || a.state.status === 'verified');
  const openActs = acts.items.filter((a) => !(a.state.status === 'done' || a.state.status === 'verified' || a.state.status === 'wontfix'));

  return `<!doctype html><html lang="ro"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Raport GEO — ${esc(p.name)}</title>
<style>
:root{--ink:#14171f;--mut:#5d6474;--line:#e3e6ee;--acc:#3b5bdb;--ok:#2b8a3e;--warn:#e67700;--bad:#c92a2a}
*{box-sizing:border-box}body{font:14px/1.55 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--ink);margin:0;background:#f6f7fb}
main{max-width:960px;margin:0 auto;padding:40px 32px;background:#fff}
h1{font-size:26px;margin:0 0 4px}h2{font-size:18px;margin:32px 0 10px;padding-bottom:6px;border-bottom:1px solid var(--line)}
.mut{color:var(--mut)}.kpis{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin:18px 0}
.kpi{border:1px solid var(--line);border-radius:10px;padding:12px}.kpi b{display:block;font-size:24px}.kpi span{font-size:12px;color:var(--mut)}
table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}th{font-weight:600;color:var(--mut)}
.bar{height:8px;background:#edf0f7;border-radius:4px;overflow:hidden}.bar i{display:block;height:100%;background:var(--acc)}
.tag{display:inline-block;padding:1px 7px;border-radius:9px;font-size:11px;background:#edf0f7}.P0{background:#ffe3e3;color:var(--bad)}.P1{background:#fff3bf;color:#8a5a00}.P2{background:#e7f5ff;color:#1864ab}
.ok{color:var(--ok)}.note{font-size:12px;color:var(--mut);background:#f8f9fc;border:1px solid var(--line);border-radius:8px;padding:10px 12px}
.banner{background:#fff4e6;border:1px solid #ffd8a8;padding:8px 12px;border-radius:8px;margin:12px 0}
@media print{body{background:#fff}main{padding:0}.noprint{display:none}h2{break-after:avoid}tr{break-inside:avoid}}
</style></head><body><main>
<div class="noprint" style="text-align:right"><button onclick="print()">Salvează ca PDF</button></div>
<h1>Raport vizibilitate AI (GEO) — ${esc(p.name)}</h1>
<div class="mut">${esc(p.domain)}${isLocal(p) && p.city ? ' · ' + esc(p.city) : ''} · ultimele ${days} zile · generat ${new Date().toLocaleDateString('ro-RO')}</div>
${p.demo ? '<div class="banner"><b>Proiect demonstrativ:</b> răspunsurile sunt simulate, nu provin de la motoarele reale.</div>' : ''}

<div class="kpis">
<div class="kpi"><b>${a.visibilityScore.score}</b><span>Scor vizibilitate AI (0–100)</span></div>
<div class="kpi"><b>${pct(m.overall.visibility)}</b><span>Share of answers (±${Math.round(((m.overall.visibilityCi[1] - m.overall.visibilityCi[0]) / 2) * 100)} pp, n=${m.overall.n})</span></div>
<div class="kpi"><b>${pct(m.overall.citationRate)}</b><span>Site propriu citat</span></div>
<div class="kpi"><b>${audit ? audit.score + '/100' : '—'}</b><span>Scor audit GEO${hist.length > 1 ? ` (inițial ${hist[0].score})` : ''}</span></div>
</div>
${first && last && first.date !== last.date ? `<p>Evoluție vizibilitate: <b>${pct(first.visibility)}</b> (${first.date}) → <b>${pct(last.visibility)}</b> (${last.date}).</p>` : ''}

<h2>Pe motor AI</h2>
<table><tr><th>Motor</th><th>Vizibilitate</th><th>Poziție medie</th><th>Recomandat (din mențiuni)</th><th>Citat</th><th>n</th></tr>
${engines.map(([e, b]) => `<tr><td>${ENGINE_LABEL[e]}</td><td><div class="bar"><i style="width:${pct(b.visibility)}"></i></div>${pct(b.visibility)}</td><td>${b.avgPosition ? b.avgPosition.toFixed(1) : '—'}</td><td>${pct(b.recommendationRate)}</td><td>${pct(b.citationRate)}</td><td>${b.n}</td></tr>`).join('')}
</table>

<h2>Cine apare în răspunsuri</h2>
<table><tr><th>Brand</th><th>Share of answers</th><th>Share of voice</th><th>Poziție medie</th><th>Ton</th></tr>
${a.brands.slice(0, 10).map((r) => `<tr><td>${r.own ? '<b>' + esc(r.brand) + '</b> (dvs.)' : esc(r.brand)}${r.tracked ? '' : ' <span class="tag">descoperit</span>'}</td><td>${pct(r.shareOfAnswers)}</td><td>${pct(r.shareOfVoice)}</td><td>${r.avgPosition ? r.avgPosition.toFixed(1) : '—'}</td><td>${r.tone != null ? r.tone.toFixed(1) : '—'}</td></tr>`).join('')}
</table>

<h2>Brandul ales de fiecare AI</h2>
<table><tr><th>Motor</th><th>Nr. 1</th><th>Locul ${esc(p.name)}</th></tr>
${(Object.keys(a.engineTop) as EngineId[]).map((e) => `<tr><td>${ENGINE_LABEL[e]}</td><td>${esc(a.engineTop[e]!.brand)} (${pct(a.engineTop[e]!.share)})</td><td>${a.engineTop[e]!.ownRank ?? '—'}</td></tr>`).join('')}
</table>

<h2>Pe topicuri</h2>
<table><tr><th>Topic</th><th>Vizibilitate</th><th>Lider</th></tr>
${a.topics.filter((t) => t.n).map((t) => `<tr><td>${esc(t.topic)}</td><td>${pct(t.visibility)}</td><td>${esc(t.leader)}</td></tr>`).join('')}
</table>

${a.perception.pos.length || a.perception.neg.length ? `<h2>Ce spune AI-ul despre ${esc(p.name)}</h2>
<p><b>Pozitiv:</b> ${a.perception.pos.slice(0, 6).map((x) => `${esc(x.text)} (${x.count})`).join(', ') || '—'}</p>
<p><b>Negativ:</b> ${a.perception.neg.slice(0, 6).map((x) => `${esc(x.text)} (${x.count})`).join(', ') || '—'}</p>
<p class="mut">Ton mediu: ${own?.tone != null ? own.tone.toFixed(1) + '/10' : '—'}</p>` : ''}

<h2>Prompturi unde lipsiți</h2>
<table><tr><th>Prompt</th><th>Pe cine recomandă AI-ul</th></tr>
${m.prompts.filter((x) => x.intent !== 'brand' && Object.keys(x.perEngine).length && x.visibility === 0).slice(0, 10).map((x) => `<tr><td>${esc(x.text)}</td><td>${esc(x.winners.slice(0, 3).map((w) => w.brand).join(', '))}</td></tr>`).join('') || '<tr><td colspan="2" class="ok">Apăreți pe toate prompturile urmărite.</td></tr>'}
</table>

<h2>Sursele care influențează răspunsurile</h2>
<table><tr><th>Domeniu</th><th>Tip</th><th>% răspunsuri</th><th>Apăreți acolo?</th></tr>
${sources.rows.slice(0, 12).map((r) => `<tr><td>${esc(r.domain)}</td><td>${SOURCE_TYPE_LABEL[r.type]}</td><td>${pct(r.share)}</td><td>${r.type === 'owned' ? '—' : r.withOwn ? 'da (' + r.withOwn + ')' : '<b>nu</b>'}</td></tr>`).join('')}
</table>

${audit ? `<h2>Audit GEO pe piloni</h2><table><tr><th>Pilon</th><th>Scor</th></tr>
${(Object.keys(audit.pillarScores) as Pillar[]).map((k) => `<tr><td>${PILLAR_LABEL[k]}</td><td>${audit.pillarScores[k].score} / ${audit.pillarScores[k].max}</td></tr>`).join('')}</table>` : ''}

<h2>Plan de acțiuni — ${acts.progress.done} din ${acts.progress.total} finalizate</h2>
<div class="bar" style="height:12px"><i style="width:${acts.progress.total ? (acts.progress.done / acts.progress.total) * 100 : 0}%"></i></div>
<h3 style="font-size:14px">Finalizate</h3>
<table>${doneActs.map((a) => `<tr><td class="ok">✓</td><td>${esc(a.title)}</td><td>${esc(a.state.owner)}</td><td>${a.state.evidenceUrl ? `<a href="${esc(a.state.evidenceUrl)}">dovadă</a>` : ''}</td><td class="mut">${esc(a.state.updatedAt.slice(0, 10))}</td></tr>`).join('') || '<tr><td class="mut">—</td></tr>'}</table>
<h3 style="font-size:14px">Următorii pași</h3>
<table>${openActs.slice(0, 15).map((a) => `<tr><td><span class="tag ${a.priority}">${a.priority}</span></td><td><b>${esc(a.title)}</b><br><span class="mut">${esc(a.why)}</span></td><td>${esc(a.state.status === 'in_progress' ? 'în lucru' : 'de făcut')}</td></tr>`).join('')}</table>

<h2>Metodologie și limite</h2>
<div class="note">
Prompturi urmărite: ${svc.store.listPrompts(projectId).filter((q) => q.active).length} · rulări în perioadă: ${runs.filter((r) => Date.now() - Date.parse(r.createdAt) < days * 86400000).length} · răspunsuri valide: ${m.overall.n} · erori/refuzuri: ${m.overall.errors}.
Motoarele sunt interogate prin API-urile oficiale cu căutare web activă, cu localizare ${esc(p.country)}${isLocal(p) && p.city ? '/' + esc(p.city) : ''}; răspunsurile din aplicațiile de consum pot diferi (personalizare, istoric, locație).
Fiecare prompt este repetat de mai multe ori pentru că răspunsurile AI nu sunt deterministe; intervalul afișat la vizibilitate este interval Wilson 95%.
Prompturile care conțin numele brandului sunt excluse din vizibilitate și share of voice. Nimeni nu poate garanta o poziție într-un răspuns AI; raportul măsoară probabilitatea de apariție pe un eșantion fix.
</div>
</main></body></html>`;
}
