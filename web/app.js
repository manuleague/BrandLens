// BrandLens — interfața web (vanilla JS, fără build). Router pe hash, randare din template-uri.

const $ = (s, r = document) => r.querySelector(s);
const main = $('#main');
const side = $('#side');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const pct = (x, d = 0) => (x == null || Number.isNaN(x) ? '—' : `${(x * 100).toFixed(d)}%`);
const num = (x, d = 1) => (x == null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
const fmtDate = (s) => (s ? new Date(s).toLocaleString('ro-RO', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '—');
const fmtDay = (s) => (s ? new Date(s).toLocaleDateString('ro-RO', { day: '2-digit', month: 'short' }) : '—');
let META = null;
let ENGINE_HEALTH = null;
let pollTimer = null;
const state = { actFilter: { priority: '', category: '', status: 'open' }, openAct: new Set(), promptSel: null, promptFilter: { topic: '', intent: '' }, openBrand: null, srcFilter: '' };

async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { 'content-type': 'application/json', ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined });
  const ct = res.headers.get('content-type') || '';
  const data = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data?.error || `Eroare ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), 3200);
}

const LOGO = `<svg width="26" height="26" viewBox="0 0 32 32" aria-hidden="true"><circle cx="14" cy="14" r="9" fill="none" stroke="#3fc1ad" stroke-width="4"/><path d="M21 21l7 7" stroke="#fff" stroke-width="4" stroke-linecap="round"/></svg>`;
const ENGINE_ORDER = ['chatgpt', 'gemini', 'perplexity', 'claude', 'simulator'];
const engLabel = (e) => META?.engineLabels?.[e] ?? e;
const sortEngines = (list) => [...list].sort((a, b) => ENGINE_ORDER.indexOf(a) - ENGINE_ORDER.indexOf(b));
const INTENT = { category: 'Categorie', comparison: 'Comparație', use_case: 'Caz de utilizare', local: 'Local / zonă', price: 'Preț', trust: 'Încredere', brand: 'Brand (acuratețe)' };
const STAGE = { awareness: 'Descoperire', consideration: 'Evaluare', decision: 'Decizie' };
const CAT = { technical: 'Tehnic', entity: 'Entitate / NAP', content: 'Conținut', offsite: 'Surse terțe', reputation: 'Reputație', measurement: 'Măsurare' };
const STATUS = { todo: 'De făcut', in_progress: 'În lucru', done: 'Făcut', verified: 'Verificat', wontfix: 'Nu se aplică' };
const VERT = { restaurant: 'Restaurant / cafenea', local_service: 'Serviciu local', ecommerce: 'Magazin online', b2b: 'B2B / SaaS', generic: 'Altul' };
const SCOPE = { local: 'Local (clienți din zonă)', national: 'Național', international: 'Internațional' };
const GEN_LABEL = { schema: 'Generează schema JSON-LD', robots: 'Generează robots.txt', faq: 'Generează FAQ', brief: 'Generează brief de conținut', outreach: 'Generează email de outreach', ga4: 'Ghid GA4', nap: 'Fișa NAP', reviews: 'Plan de recenzii', llms: 'Generează llms.txt' };
const COLORS = ['#0e7366', '#6b3fa0', '#3b5a72', '#a35a00', '#8a6d3b', '#b42318', '#2f8f83', '#9a7bc4', '#c48a2c', '#5b6870'];
const ENGINE_COLOR = { chatgpt: '#3b5a72', gemini: '#a35a00', perplexity: '#6b3fa0', claude: '#8a6d3b', simulator: '#888' };

// ───────────────────────────── Sidebar
function renderSide(project) {
  const eng = META ? sortEngines(Object.keys(META.engines).filter((e) => e !== 'simulator')) : [];
  const base = project ? `#/p/${project.id}` : '';
  const cur = location.hash.replace(/\?.*$/, '');
  const link = (href, label) => `<a href="${href}" ${cur === href ? 'aria-current="page"' : ''}>${label}</a>`;
  const pill = (e) => {
    const s = META.engines[e];
    const h = ENGINE_HEALTH?.[e];
    const cls = !s.configured ? '' : h && !h.ok ? 'bad' : 'on';
    const title = !s.configured ? 'Cheie API lipsă în .env' : h && !h.ok ? `Eroare: ${h.error}` : `Model: ${s.model}`;
    return `<span class="${cls}" title="${esc(title)}">${engLabel(e)}</span>`;
  };
  side.innerHTML = `
    <a class="logo" href="#/">${LOGO}<span>BrandLens</span></a>
    <nav>${link('#/', 'Toate proiectele')}${link('#/new', 'Proiect nou')}</nav>
    ${project ? `<div class="sep"></div>
      <div class="proj"><b>${esc(project.name)}</b><span>${esc(project.domain)}</span></div>
      <nav>
        ${link(base, 'Privire de ansamblu')}
        ${link(base + '/competitors', 'Competitori')}
        ${link(base + '/prompts', 'Prompturi și răspunsuri')}
        ${link(base + '/sources', 'Surse citate')}
        ${link(base + '/perception', 'Percepție')}
        ${link(base + '/actions', 'Audit și acțiuni')}
        ${link(base + '/optimize', 'Optimizator conținut')}
        ${link(base + '/crawlers', 'Crawlere AI')}
        ${link(base + '/report', 'Raport client')}
        ${link(base + '/settings', 'Setări proiect')}
      </nav>` : ''}
    <div class="foot">Motoare conectate
      <div class="eng">${eng.map(pill).join('')}</div>
      <button class="btn ghost sm" id="testEng" style="color:#9fd8cf;padding-left:0;margin-top:6px">Testează conexiunile</button>
      <div style="margin-top:6px">${META?.analysis?.enabled ? `Analiză AI: ${esc(META.analysis.provider)}` : 'Analiză AI: dezactivată'}</div>
    </div>`;
  $('#testEng').onclick = () => openEngineTest();
}

async function openEngineTest() {
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="box" role="dialog" aria-modal="true"><header><h2>Testez conexiunile…</h2></header><div class="content"><p class="muted">Trimit câte o cerere minimă fiecărui motor configurat.</p></div></div>`;
  try {
    const r = await api('/api/engines/test', { method: 'POST' });
    ENGINE_HEALTH = r.results;
    META.analysis = r.analysis;
    modal.innerHTML = `<div class="box" role="dialog" aria-modal="true"><header><h2>Conexiuni motoare AI</h2><button class="btn" id="close">Închide</button></header><div class="content">
      <table class="t"><thead><tr><th>Motor</th><th>Model</th><th>Cheie</th><th>Rezultat</th></tr></thead><tbody>
      ${sortEngines(Object.keys(r.results)).map((e) => { const x = r.results[e]; return `<tr><td><b>${engLabel(e)}</b></td><td class="small">${esc(x.model)}</td><td class="small muted">${esc(x.key)}</td>
        <td>${!x.configured ? '<span class="muted">neconfigurat</span>' : x.ok ? `<span class="st-pass">funcționează</span> <span class="muted small">${x.ms} ms</span>` : `<span class="st-fail">${esc(x.error)}</span>${x.hint ? `<div class="small" style="margin-top:4px">${esc(x.hint)}</div>` : ''}`}</td></tr>`; }).join('')}
      </tbody></table>
      <p class="small muted" style="margin-top:12px">Cheile se setează în fișierul <b>.env</b> din folderul aplicației; după modificare reporniți serverul. ${r.analysis.enabled ? `Analiza AI a răspunsurilor folosește ${esc(r.analysis.provider)} / ${esc(r.analysis.model)}.` : 'Fără o cheie validă, analiza răspunsurilor folosește doar regulile deterministe.'}</p></div></div>`;
    $('#close').onclick = () => { modal.hidden = true; router(); };
  } catch (e) {
    modal.innerHTML = `<div class="box"><header><h2>Eroare</h2><button class="btn" id="close">Închide</button></header><div class="content">${esc(e.message)}</div></div>`;
    $('#close').onclick = () => (modal.hidden = true);
  }
}

// ───────────────────────────── Router
async function router() {
  clearTimeout(pollTimer);
  const h = location.hash.replace(/^#/, '') || '/';
  const m = h.match(/^\/p\/([\w-]+)(?:\/(\w+))?/);
  try {
    if (!META) META = await api('/api/meta');
    if (h === '/' || h === '') return await viewHome();
    if (h === '/new') return viewNew();
    if (m) {
      const p = await api(`/api/projects/${m[1]}`);
      renderSide(p);
      const v = m[2] || 'overview';
      const views = { overview: viewOverview, competitors: viewCompetitors, prompts: viewPrompts, sources: viewSources, perception: viewPerception, actions: viewActions, optimize: viewOptimize, crawlers: viewCrawlers, report: viewReport, settings: viewSettings };
      if (views[v]) return await views[v](p);
    }
    main.innerHTML = '<p class="pad">Pagina nu există.</p>';
  } catch (e) {
    main.innerHTML = `<div class="pad"><h2>Nu am putut încărca pagina</h2><p class="muted" style="margin-top:8px">${esc(e.message)}</p></div>`;
  }
}
window.addEventListener('hashchange', router);

// ───────────────────────────── Grafice SVG
function lineChart(series, { height = 240, max = null, fmt = (v) => pct(v) } = {}) {
  const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.x)))].sort();
  if (dates.length < 2) return `<p class="muted small">Graficul apare după a doua zi de rulare.</p>`;
  const top = max ?? Math.min(1, Math.max(0.1, ...series.flatMap((s) => s.points.map((p) => p.y))) * 1.15);
  const W = 720, H = height, L = 42, R = 175, T = 12, B = 26;
  const x = (d) => L + (dates.indexOf(d) / (dates.length - 1)) * (W - L - R);
  const y = (v) => T + (1 - v / top) * (H - T - B);
  const grid = [0, 0.25, 0.5, 0.75, 1].map((v) => `<line x1="${L}" x2="${W - R}" y1="${y(v * top)}" y2="${y(v * top)}" stroke="#e7ece9"/><text x="${L - 6}" y="${y(v * top) + 4}" text-anchor="end">${fmt(v * top)}</text>`).join('');
  const lbl = dates.map((d, i) => (i === 0 || i === dates.length - 1 || dates.length < 8 ? `<text x="${x(d)}" y="${H - 6}" text-anchor="middle">${fmtDay(d)}</text>` : '')).join('');
  // etichetele de la capăt, distanțate ca să nu se suprapună
  const ends = series.map((s) => ({ s, last: [...s.points].sort((a, b) => a.x.localeCompare(b.x)).at(-1) })).filter((e) => e.last).sort((a, b) => y(a.last.y) - y(b.last.y));
  let prevY = -Infinity;
  const endLabels = ends.map((e) => {
    let ly = Math.max(y(e.last.y) + 4, prevY + 13);
    prevY = ly;
    return `<text x="${W - R + 8}" y="${ly}" style="fill:${e.s.color};font-weight:${e.s.width > 2 ? 700 : 500}">${esc(e.s.name.length > 19 ? e.s.name.slice(0, 18) + '…' : e.s.name)} ${fmt(e.last.y)}</text>`;
  }).join('');
  const lines = series.map((s) => {
    const pts = [...s.points].sort((a, b) => a.x.localeCompare(b.x));
    const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(p.x).toFixed(1)},${y(p.y).toFixed(1)}`).join(' ');
    return `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.dash ? 'stroke-dasharray="4 4"' : ''}/>
      ${pts.map((p) => `<circle cx="${x(p.x)}" cy="${y(p.y)}" r="${s.width > 2 ? 4 : 3}" fill="${s.color}"><title>${esc(s.name)}: ${fmt(p.y)} (${p.x})</title></circle>`).join('')}`;
  }).join('');
  return `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Evoluție în timp">${grid}${lbl}${lines}${endLabels}</svg>`;
}

function hbars(rows, { fmt = (v) => pct(v), color = 'var(--you)', max = null } = {}) {
  const m = max ?? Math.max(0.0001, ...rows.map((r) => r.value));
  return `<div class="hbars">${rows.map((r) => `<div class="hb ${r.own ? 'own' : ''}"><span class="hb-l" title="${esc(r.label)}">${esc(r.label)}</span><span class="hb-t"><i style="width:${(r.value / m) * 100}%;background:${r.color || color}"></i></span><span class="hb-v">${fmt(r.value)}</span></div>`).join('')}</div>`;
}

const delta = (d, { invert = false, fmt = (v) => `${(v * 100).toFixed(1)} pp` } = {}) => {
  if (d == null || Math.abs(d) < 1e-9) return '';
  const good = invert ? d < 0 : d > 0;
  return `<span class="delta ${good ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${fmt(Math.abs(d))}</span>`;
};

// ───────────────────────────── Bannere comune
/** Ce are de făcut utilizatorul, după tipul erorii (nu orice eroare e o cheie greșită). */
function errorAdvice(err = '') {
  if (/429|quota|RESOURCE_EXHAUSTED|rate limit/i.test(err))
    return /zilnică|PerDay/i.test(err)
      ? 'Cota zilnică a furnizorului e consumată; rularea s-a oprit ca să nu umple raportul cu erori. Reluați mâine, sau activați facturarea pe proiectul cheii (pentru Gemini: Google AI Studio → Billing). Ca să consumați mai puțin: 1 repetare în Setări și ANALYSIS=0 în .env.'
      : 'Limita de cereri a furnizorului e atinsă (frecvent pe planul gratuit). Rulați cu 1 repetare în Setări, puneți ANALYSIS=0 în .env (o singură cerere per întrebare) sau activați facturarea pe proiectul cheii.';
  if (/\b(503|529)\b|overloaded|high demand/i.test(err)) return 'Modelul e suprasolicitat temporar la furnizor. Reîncercați peste câteva minute; aplicația încearcă automat și modele de rezervă.';
  if (/lipsește|missing/i.test(err)) return 'Motorul nu are cheie în .env. Adăugați cheia și reporniți serverul, sau debifați motorul în Setări proiect.';
  return 'Cheile se corectează în fișierul .env; apoi reporniți serverul și rulați din nou.';
}

function auditBanner(d, p) {
  const b = d.auditBlocked;
  if (!b || p.demo) return '';
  return `<div class="banner warn"><b>Auditul din ${fmtDate(b.at)} nu a putut citi ${esc(p.domain)}</b>: ${esc(b.reason)}. ${b.showingFrom ? `Afișăm auditul reușit din ${fmtDate(b.showingFrom)}.` : 'Scorul de audit nu e disponibil până la un audit reușit.'} Aplicația reîncearcă singură peste câteva ore; apăsarea repetată pe „Audit nou” poate prelungi blocarea.</div>`;
}
function runBanner(d, p) {
  return runBanner0(d, p) + auditBanner(d, p);
}
function runBanner0(d, p) {
  const rs = d.runStatus;
  if (p.demo) return `<div class="banner">Proiect demonstrativ: răspunsurile AI sunt simulate, ca să poți explora aplicația. Pentru date reale creează un proiect nou.</div>`;
  if (rs?.last?.error && (rs.failed || rs.partial)) {
    return `<div class="banner bad"><b>${rs.failed ? 'Ultima rulare a eșuat' : 'Ultima rulare are erori'}</b> (${rs.last.errors} din ${rs.last.done} cereri, ${fmtDate(rs.last.createdAt)}): ${esc(rs.last.error)}
      <div class="row" style="margin-top:8px"><button class="btn sm" onclick="document.getElementById('testEng').click()">Testează conexiunile</button><span class="small">${errorAdvice(rs.last.error)}</span></div></div>`;
  }
  return '';
}

function jobsBar(d) {
  if (!d.jobs.length) return '';
  const runRow = d.runs.find((r) => r.status === 'running' || r.status === 'queued');
  const label = { run: `Rulez prompturile${runRow ? ` (${runRow.done}/${runRow.total})` : ''}`, audit: 'Auditez site-ul', setup: 'Generez prompturile cu AI', analyze: 'Re-analizez răspunsurile' };
  return `<span class="job"><span class="dot"></span>${d.jobs.map((j) => label[j.type] || j.type).join(' · ')}…</span>`;
}

function bindRunButtons(p, rerender) {
  $('#runNow')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    try {
      await api(`/api/projects/${p.id}/runs`, { method: 'POST', body: {} });
      toast('Rularea a pornit');
      rerender();
    } catch (e) {
      toast(e.message);
      ev.target.disabled = false;
    }
  });
  $('#auditNow')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    await api(`/api/projects/${p.id}/audit`, { method: 'POST', body: {} });
    toast(p.demo ? 'Proiectul demo nu are site real; auditul va eșua pe domeniul fictiv' : 'Auditul a pornit');
    rerender();
  });
}
const poll = (d, fn) => { if (d.jobs.length) pollTimer = setTimeout(fn, 3000); };
const headerButtons = (d) => `<div class="row">${jobsBar(d)}<button class="btn" id="auditNow" ${d.jobs.some((j) => j.type === 'audit') ? 'disabled' : ''}>Audit nou</button><button class="btn primary" id="runNow" ${d.jobs.some((j) => j.type === 'run' || j.type === 'setup') ? 'disabled' : ''}>Rulează prompturile acum</button></div>`;
const getDash = (p, days = 30) => api(`/api/projects/${p.id}/dashboard?days=${days}`);

// ───────────────────────────── Home
async function viewHome() {
  renderSide(null);
  const ps = await api('/api/projects');
  if (!ps.length) {
    main.innerHTML = `<div class="empty pad">
      <h1>Află dacă ChatGPT, Gemini, Perplexity și Claude recomandă business-ul tău</h1>
      <p>Introdu site-ul. BrandLens îl analizează, propune topicurile, competitorii și întrebările pe care le pun clienții, apoi măsoară cine e recomandat, ce surse citează AI-ul și ce trebuie schimbat.</p>
      <div class="row"><a class="btn primary" href="#/new">Analizează primul brand</a><button class="btn" id="demo">Deschide proiectul demo</button></div>
      <p class="small" style="margin-top:14px">Proiectul demo folosește răspunsuri simulate, ca să poți explora aplicația fără chei API.</p></div>`;
  } else {
    main.innerHTML = `<div class="head"><div><h1>Proiecte</h1><p class="sub">${ps.length} ${ps.length === 1 ? 'brand urmărit' : 'branduri urmărite'}</p></div>
      <div class="row"><button class="btn" id="demo">Proiect demo</button><a class="btn primary" href="#/new">Proiect nou</a></div></div>
      <div class="plist">${ps.map((p) => `<a class="pitem" href="#/p/${p.id}">
        <div><h2>${esc(p.name)}</h2><span class="muted small">${esc(p.domain)}${p.city ? ', ' + esc(p.city) : ''}${p.demo ? ' (demo)' : ''}</span></div>
        <div class="nums"><div><b>${p.kpi.n ? pct(p.kpi.visibility) : '—'}</b><span class="muted small">vizibilitate AI</span></div>
        <div><b>${p.kpi.score ?? '—'}</b><span class="muted small">scor audit</span></div></div>
        <span class="muted small">Ultima rulare: ${fmtDate(p.kpi.lastRunAt)}</span></a>`).join('')}</div>`;
  }
  $('#demo')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true;
    const p = await api('/api/demo', { method: 'POST' });
    location.hash = `#/p/${p.id}`;
  });
}

// ───────────────────────────── Formular proiect (folosit la creare și în setări)
const linesOf = (v) => String(v || '').split('\n').map((x) => x.trim()).filter(Boolean);
function projectForm(p = {}) {
  const f = p.facts || {};
  const configured = Object.entries(META.engines).filter(([e, s]) => s.configured && e !== 'simulator').map(([e]) => e);
  const engines = p.engines || configured;
  const comps = (p.competitors || []).map((c) => [c.name, c.domain].filter(Boolean).join(' | ')).join('\n');
  const topics = (p.topics || []).map((t) => (t.description ? `${t.name} — ${t.description}` : t.name)).join('\n');
  const personas = (p.personas || []).map((x) => `${x.name}: ${x.description}`).join('\n');
  return `
    <label class="f">Numele brandului<input type="text" name="name" required value="${esc(p.name)}" placeholder="eMAG"></label>
    <label class="f">Site<input type="text" name="domain" required value="${esc(p.domain)}" placeholder="emag.ro"></label>
    <label class="f">Tip de business<select name="vertical">${Object.entries(VERT).map(([k, v]) => `<option value="${k}" ${p.vertical === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="f">Acoperire<select name="scope">${Object.entries(SCOPE).map(([k, v]) => `<option value="${k}" ${(p.scope || 'national') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
    <label class="f">Categoria <span class="hint">cum ar spune un client: „magazin online de electronice”, „pizzerie”</span><input type="text" name="category" value="${esc(p.category)}"></label>
    <label class="f">Oraș <span class="hint">doar pentru business local</span><input type="text" name="city" value="${esc(p.city)}"></label>
    <label class="f full">Descriere factuală<input type="text" name="description" value="${esc(p.description || f.description)}"></label>
    <label class="f">Topicuri <span class="hint">unul pe rând: „Nume — descriere”; fiecare devine un grup de întrebări</span><textarea name="topics" rows="6">${esc(topics)}</textarea></label>
    <label class="f">Competitori <span class="hint">unul pe rând: Nume | domeniu</span><textarea name="competitors" rows="6">${esc(comps)}</textarea></label>
    <label class="f">Persone de cumpărător <span class="hint">„Nume: cum se descrie, la persoana I”</span><textarea name="personas" rows="4">${esc(personas)}</textarea></label>
    <label class="f">Alte denumiri ale brandului <span class="hint">virgulă</span><input type="text" name="aliases" value="${esc((p.aliases || []).join(', '))}"><span class="hint" style="margin-top:8px">Zone deservite <span class="hint">(local, virgulă)</span></span><input type="text" name="neighborhoods" value="${esc((p.neighborhoods || []).join(', '))}"></label>
    <fieldset><legend>Setul de adevăr</legend>
      <p class="muted small" style="grid-column:1/-1">Datele oficiale. Le folosim ca să verificăm consistența pe site și dacă AI-ul spune lucruri corecte despre tine.</p>
      <label class="f">Adresă<input type="text" name="f_address" value="${esc(f.address)}"></label>
      <label class="f">Telefon<input type="text" name="f_phone" value="${esc(f.phone)}"></label>
      <label class="f">Program <span class="hint">ex: Mo-Fr 09:00-18:00</span><input type="text" name="f_hours" value="${esc(f.hours)}"></label>
      <label class="f">Interval de preț<input type="text" name="f_priceRange" value="${esc(f.priceRange)}"></label>
      <label class="f full" style="grid-column:1/-1">Profiluri oficiale <span class="hint">URL-uri separate prin virgulă</span><input type="text" name="f_profiles" value="${esc((f.profiles || []).join(', '))}"></label>
    </fieldset>
    <fieldset><legend>Monitorizare</legend>
      <div class="f full" style="grid-column:1/-1"><span style="font-size:13px;font-weight:550">Motoare AI</span>
        <div class="row" style="margin-top:6px">${sortEngines(Object.keys(META.engines).filter((e) => e !== 'simulator')).map((e) => `<label class="check"><input type="checkbox" name="engines" value="${e}" ${engines.includes(e) ? 'checked' : ''} ${META.engines[e].configured ? '' : 'disabled'}> ${engLabel(e)}${META.engines[e].configured ? (ENGINE_HEALTH?.[e] && !ENGINE_HEALTH[e].ok ? ' <span class="st-fail small">(eroare cheie)</span>' : '') : ' <span class="muted small">(fără cheie)</span>'}</label>`).join('')}</div></div>
      <label class="f">Repetări per prompt <span class="hint">răspunsurile AI variază; 3 e un minim rezonabil</span><input type="number" name="repetitions" min="1" max="10" value="${p.repetitions ?? 3}"></label>
      <label class="f">Rulare automată<select name="schedule">${[['weekly', 'Săptămânal'], ['daily', 'Zilnic'], ['manual', 'Doar manual']].map(([k, v]) => `<option value="${k}" ${(p.schedule || 'weekly') === k ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label class="check"><input type="checkbox" name="usePersonas" ${p.usePersonas ? 'checked' : ''}> Pune fiecare întrebare și ca fiecare persona${(p.personas || []).length ? ` (cost × ${1 + p.personas.length})` : " (adaugă persone mai sus)"}</label>
      <label class="check"><input type="checkbox" name="lang_en" ${(p.languages || []).includes('en') ? 'checked' : ''}> Include întrebări în engleză</label>
    </fieldset>`;
}

function readProjectForm(form) {
  const fd = new FormData(form);
  const list = (k) => String(fd.get(k) || '').split(',').map((x) => x.trim()).filter(Boolean);
  return {
    name: fd.get('name'),
    domain: fd.get('domain'),
    vertical: fd.get('vertical'),
    scope: fd.get('scope'),
    category: fd.get('category') || undefined,
    city: fd.get('city') || undefined,
    description: fd.get('description') || undefined,
    neighborhoods: list('neighborhoods'),
    services: [],
    topics: linesOf(fd.get('topics')).map((l) => { const [name, ...d] = l.split(/\s+[—–-]\s+/); return { name: name.trim(), description: d.join(' — ').trim() || undefined }; }),
    personas: linesOf(fd.get('personas')).map((l) => { const i = l.indexOf(':'); return i > 0 ? { name: l.slice(0, i).trim(), description: l.slice(i + 1).trim() } : { name: l, description: l }; }),
    usePersonas: !!fd.get('usePersonas'),
    aliases: list('aliases'),
    competitors: linesOf(fd.get('competitors')).map((l) => l.split('|').map((x) => x.trim())).filter((x) => x[0]).map(([name, domain]) => ({ name, domain: domain || undefined })),
    facts: { address: fd.get('f_address') || undefined, phone: fd.get('f_phone') || undefined, hours: fd.get('f_hours') || undefined, priceRange: fd.get('f_priceRange') || undefined, description: fd.get('description') || undefined, profiles: list('f_profiles'), city: fd.get('city') || undefined },
    engines: fd.getAll('engines'),
    repetitions: Number(fd.get('repetitions') || 3),
    schedule: fd.get('schedule'),
    languages: fd.get('lang_en') ? ['ro', 'en'] : ['ro'],
  };
}

// ───────────────────────────── Proiect nou: pasul 1 analiză AI, pasul 2 confirmare
function viewNew() {
  renderSide(null);
  const ai = META.analysis?.enabled;
  main.innerHTML = `<div class="head"><div><h1>Proiect nou</h1><p class="sub">Pasul 1 din 2: introdu site-ul. BrandLens îl citește și propune profilul, topicurile, competitorii și personele.</p></div></div>
    ${ai ? '' : `<div class="banner">Nu există o cheie AI validă pentru analiză, așa că profilul se completează doar din datele găsite în HTML (nume, contact, meniu de navigație). Restul îl completezi manual. Verifică cheile cu „Testează conexiunile”.</div>`}
    <form class="panel row" id="step1" style="gap:12px">
      <label class="f grow" style="flex:1;min-width:260px">Site-ul brandului<input type="text" name="domain" required placeholder="emag.ro" autofocus></label>
      <button class="btn primary" style="align-self:flex-end">Analizează site-ul</button>
      <button class="btn" type="button" id="skip" style="align-self:flex-end">Completez manual</button>
    </form>
    <div id="step2"></div>`;
  $('#skip').onclick = () => showStep2({ vertical: 'generic', scope: 'national' }, null);
  $('#step1').onsubmit = async (ev) => {
    ev.preventDefault();
    const domain = new FormData(ev.target).get('domain');
    const btn = ev.submitter;
    btn.disabled = true;
    $('#step2').innerHTML = `<div class="panel" style="margin-top:16px"><span class="job"><span class="dot"></span>Citesc paginile principale${ai ? ' și construiesc profilul cu AI' : ''}… (20–60 secunde)</span></div>`;
    try {
      const prof = await api('/api/profile', { method: 'POST', body: { domain } });
      showStep2({
        name: prof.brandName, domain, vertical: prof.vertical, scope: prof.scope, category: prof.category, categoryEn: prof.categoryEn, city: prof.city, description: prof.description,
        topics: prof.topics, personas: prof.personas, competitors: prof.competitors, aliases: prof.aliases, usps: prof.usps, facts: prof.facts, country: prof.country, languages: prof.languages,
      }, prof);
    } catch (e) {
      $('#step2').innerHTML = `<div class="banner bad" style="margin-top:16px">${esc(e.message)}</div>`;
    }
    btn.disabled = false;
  };
}

function showStep2(data, prof) {
  const ai = META.analysis?.enabled;
  $('#step2').innerHTML = `
    ${prof ? `<div class="banner ${prof.source === 'ai' ? 'info' : ''}" style="margin-top:16px">${prof.source === 'ai' ? `Profil generat cu AI din ${prof.pagesRead.length} pagini citite (cost ~$${prof.costUsd.toFixed(3)}). Verifică și corectează înainte de salvare; competitorii sunt sugestii.` : `Profil construit din HTML (${prof.pagesRead.length} pagini).`}${prof.warning ? ` ${esc(prof.warning)}` : ''}</div>` : ''}
    <h2 style="margin:18px 0 10px">Pasul 2 din 2: verifică profilul</h2>
    <form class="form panel" id="pf">${projectForm(data)}
      <div class="full row">
        <label class="check"><input type="checkbox" name="aiPrompts" ${ai ? 'checked' : 'disabled'}> Generează întrebările cu AI din topicuri și persone${ai ? '' : ' (necesită cheie)'}</label>
        <label class="check"><input type="checkbox" name="autoRun" checked> Pornește prima rulare</label>
      </div>
      <div class="full row"><button class="btn primary" type="submit">Creează proiectul</button><span class="muted small">Auditul site-ului pornește imediat. Întrebările le poți edita oricând.</span></div></form>`;
  $('#pf').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.submitter;
    btn.disabled = true;
    try {
      const fd = new FormData(ev.target);
      const body = { ...readProjectForm(ev.target), categoryEn: data.categoryEn, usps: data.usps, country: data.country || 'RO' };
      const p = await api('/api/projects', { method: 'POST', body: { ...body, autoAudit: true, aiPrompts: !!fd.get('aiPrompts'), autoRun: !!fd.get('autoRun') && body.engines.length > 0 } });
      location.hash = `#/p/${p.id}`;
    } catch (e) {
      toast(e.message);
      btn.disabled = false;
    }
  });
  $('#step2').scrollIntoView({ behavior: 'smooth' });
}

// ───────────────────────────── Overview
async function viewOverview(p) {
  const d = await getDash(p);
  const m = d.metrics;
  const a = d.analytics;
  const o = m.overall;
  const own = a.brands.find((b) => b.own) || {};
  const engines = sortEngines(Object.keys(m.grid));
  const halfCi = (o.visibilityCi[1] - o.visibilityCi[0]) / 2;
  const auditFirst = d.auditHistory[0]?.score;
  const colorOf = (b, i) => (b === own.brand ? 'var(--you)' : COLORS[(i % (COLORS.length - 1)) + 1]);
  const trendSeries = a.trendBrands.map((b, i) => ({ name: b, color: colorOf(b, i), width: b === own.brand ? 3 : 2, dash: b !== own.brand, points: a.brandTrend.filter((t) => t.brand === b).map((t) => ({ x: t.date, y: t.share })) }));
  main.innerHTML = `
    <div class="head"><div><h1>${esc(p.name)}</h1><p class="sub">${esc(p.domain)}${p.city && p.scope === 'local' ? ', ' + esc(p.city) : ''}. Ultima rulare: ${fmtDate(m.lastRunAt)}. Ultimele 30 de zile, ${a.validAnswers} răspunsuri valide${a.analysisMix.llm ? `, ${a.analysisMix.llm} analizate cu AI` : ''}.</p></div>${headerButtons(d)}</div>
    ${runBanner(d, p)}
    ${!m.totalAnswers ? `<div class="banner info">Încă nu există răspunsuri. ${d.jobs.length ? 'Lucrez în fundal; pagina se actualizează singură.' : 'Apasă „Rulează prompturile acum” ca să măsori vizibilitatea.'}</div>` : ''}
    <div class="kpis k7">
      <div class="kpi lead" title="${esc(a.visibilityScore.parts.map((x) => `${x.label}: ${pct(x.value)} × ${x.weight}`).join('\n'))}"><div class="v">${o.n ? a.visibilityScore.score : '—'}</div><div class="l">Scor vizibilitate AI <span class="info-i" title="50% share of answers + 20% poziție + 20% citare + 10% ton">?</span></div></div>
      <div class="kpi"><div class="v">${o.n ? pct(own.shareOfAnswers) : '—'}</div><div class="l">Share of answers</div><div class="ci">${o.n ? `±${Math.round(halfCi * 100)} pp, n=${o.n}` : ''} ${delta(a.deltas.visibility)}</div></div>
      <div class="kpi"><div class="v">${o.n ? pct(own.shareOfVoice) : '—'}</div><div class="l">AI share of voice</div><div class="ci">${delta(a.deltas.shareOfVoice)}</div></div>
      <div class="kpi"><div class="v">${num(own.avgPosition)}</div><div class="l">Poziție medie când apari</div><div class="ci">${delta(a.deltas.avgPosition, { invert: true, fmt: (v) => v.toFixed(1) })}</div></div>
      <div class="kpi"><div class="v">${o.n ? pct(o.citationRate) : '—'}</div><div class="l">Site-ul tău citat</div></div>
      <div class="kpi"><div class="v">${own.tone != null ? num(own.tone) : '—'}</div><div class="l">Ton (0–10)${own.tone == null && own.toneN ? `, sub n=${a.minToneSample}` : ''}</div></div>
      <div class="kpi"><div class="v">${d.audit && !d.audit.unreadable ? d.audit.score : '—'}</div><div class="l">Scor audit${auditFirst !== undefined && d.audit && auditFirst !== d.audit.score ? `, inițial ${auditFirst}` : ''}</div></div>
    </div>

    <section class="panel" style="margin-bottom:20px">
      <h2>Pe ce loc te pune fiecare AI</h2>
      <p class="muted small">Pentru fiecare motor: cine apare cel mai des pe locurile 1–6. Celulele verzi arată cât de des ești tu pe acel loc.</p>
      <div class="body">${engines.length ? `<table class="lens"><thead><tr><th>Motor</th>${[1, 2, 3, 4, 5, 6].map((i) => `<th>Locul ${i}</th>`).join('')}<th>Nu apari</th></tr></thead><tbody>
        ${engines.map((e) => {
          const g = m.grid[e];
          return `<tr><td class="eng">${engLabel(e)}<div class="muted small" style="font-weight:400">${g.n} răspunsuri</div></td>
          ${g.cells.map((c) => c.ownPct >= c.topPct && c.ownPct > 0
            ? `<td class="you" style="opacity:${0.45 + Math.min(0.55, c.ownPct * 1.6)}" title="Tu pe locul ${c.pos} în ${pct(c.ownPct)} din răspunsuri"><span class="pc">${pct(c.ownPct)}</span></td>`
            : `<td title="${esc(c.top)}: ${pct(c.topPct)}${c.ownPct ? `; tu: ${pct(c.ownPct)}` : ''}"><span class="who">${esc(c.top || '—')}</span>${c.ownPct ? `<span class="small" style="color:var(--you);font-weight:600">tu ${pct(c.ownPct)}</span>` : ''}</td>`).join('')}
          <td class="miss"><span class="pc" style="color:${g.missPct > 0.6 ? 'var(--bad)' : 'var(--muted)'}">${pct(g.missPct)}</span></td></tr>`;
        }).join('')}</tbody></table>` : '<p class="muted">Fără date încă.</p>'}</div>
    </section>

    <div class="grid2">
      <section class="panel"><h2>Share of answers în timp</h2><p class="muted small">Procentul răspunsurilor care numesc fiecare brand, pe zile de rulare. Tu, cu linie plină.</p><div class="body">${lineChart(trendSeries)}</div></section>
      <section class="panel"><h2>Brandul ales de fiecare AI</h2><p class="muted small">Brandul numit cel mai des de fiecare motor și locul tău în clasamentul lui.</p>
        <div class="body"><table class="t"><thead><tr><th>Motor</th><th>Nr. 1</th><th class="num">Tu</th><th class="num">Locul tău</th><th class="num" title="branduri numite / surse afișate per răspuns">Br. / surse</th></tr></thead><tbody>
        ${sortEngines(Object.keys(a.engineTop)).map((e) => { const t = a.engineTop[e]; const av = a.engineAverages[e]; return `<tr><td>${engLabel(e)}</td><td><b>${esc(t.brand)}</b> <span class="muted small">${pct(t.share)}</span></td><td class="num">${pct(t.ownShare)}</td><td class="num">${t.ownRank ?? '—'}</td><td class="num small">${num(av?.brandsPerAnswer)} / ${num(av?.sourcesPerAnswer)}</td></tr>`; }).join('') || '<tr><td class="muted">—</td></tr>'}
        </tbody></table></div></section>
    </div>

    <div class="grid2" style="margin-top:20px">
      <section class="panel"><h2>Pe topicuri</h2><p class="muted small">Unde ești ales și cine conduce în fiecare grup de întrebări.</p>
        <div class="body"><table class="t"><thead><tr><th>Topic</th><th>Tu</th><th>Lider</th><th class="num">n</th></tr></thead><tbody>${a.topics.filter((t) => t.n).map((t) => `<tr><td>${esc(t.topic)}</td><td style="width:34%"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar grow"><i style="width:${pct(t.visibility)}"></i></div><span class="small">${pct(t.visibility)}</span></div></td><td class="small">${esc(t.leader)} ${pct(t.leaderShare)}</td><td class="num muted small">${t.n}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</tbody></table></div></section>
      <section class="panel"><h2>Ce urmează</h2><p class="muted small">Primele acțiuni din plan, după prioritate.</p><div class="body" id="nextActs"><p class="muted small">Se încarcă…</p></div>
        <div style="margin-top:10px"><a href="#/p/${p.id}/actions">Vezi tot planul de acțiuni</a></div></section>
    </div>
    <p class="muted small" style="margin-top:18px">Cost al rulărilor în perioadă (motoare + analiză AI): $${m.costUsd.toFixed(2)}. Prompturile care conțin numele brandului sunt excluse din vizibilitate. Scor vizibilitate AI = 50% share of answers + 20% poziție + 20% citare + 10% ton.</p>`;
  bindRunButtons(p, () => viewOverview(p));
  api(`/api/projects/${p.id}/actions`).then((x) => {
    const open = x.items.filter((i) => !['done', 'verified', 'wontfix'].includes(i.state.status)).slice(0, 6);
    const el = $('#nextActs');
    if (el) el.innerHTML = open.length ? `<table class="t"><tbody>${open.map((i) => `<tr><td style="width:44px"><span class="tag ${i.priority}">${i.priority}</span></td><td>${esc(i.title)}${i.aiGenerated ? ' <span class="tag ai">AI</span>' : ''}</td></tr>`).join('')}</tbody></table>` : '<p class="muted">Toate acțiunile sunt închise.</p>';
  });
  poll(d, () => viewOverview(p));
}

// ───────────────────────────── Competitori
async function viewCompetitors(p) {
  const d = await getDash(p);
  const a = d.analytics;
  const engines = sortEngines(Object.keys(a.engineTop));
  const brands = a.brands.slice(0, 30);
  main.innerHTML = `
    <div class="head"><div><h1>Competitori</h1><p class="sub">Toate brandurile pe care AI-ul le numește în răspunsuri la întrebările tale, inclusiv cele pe care nu le urmărești încă. ${a.validAnswers} răspunsuri.</p></div>${headerButtons(d)}</div>
    ${runBanner(d, p)}
    <section class="panel" style="margin-bottom:20px"><h2>Share of answers</h2><p class="muted small">Procentul răspunsurilor care numesc brandul.</p>
      <div class="body">${hbars(brands.slice(0, 12).map((b) => ({ label: b.brand, value: b.shareOfAnswers, own: b.own, color: b.own ? 'var(--you)' : b.tracked ? 'var(--comp)' : '#9aa6ad' })), { max: 1 })}
      <div class="legend"><span><i style="background:var(--you)"></i>tu</span><span><i style="background:var(--comp)"></i>competitor urmărit</span><span><i style="background:#9aa6ad"></i>descoperit în răspunsuri</span></div></div></section>
    <section class="panel"><h2>Comparație detaliată</h2><p class="muted small">Click pe un rând ca să vezi ce spune AI-ul despre brand. Tonul apare de la ${a.minToneSample} răspunsuri.</p>
      <div class="body"><table class="t"><thead><tr><th>Brand</th><th class="num">Share of answers</th><th class="num">SoV</th><th class="num">Poziție</th><th class="num">Recomandat</th><th class="num">Ton</th><th class="num">Nr. 1</th>${engines.map((e) => `<th class="num">${engLabel(e)}</th>`).join('')}<th></th></tr></thead><tbody>
      ${brands.map((b, i) => `<tr class="click ${b.own ? 'you' : ''}" data-b="${i}"><td>${b.own ? `<b>${esc(b.brand)}</b>` : esc(b.brand)} ${b.own ? '' : b.tracked ? '<span class="tag comp">urmărit</span>' : '<span class="tag">nou</span>'}</td>
        <td class="num">${pct(b.shareOfAnswers)}</td><td class="num">${pct(b.shareOfVoice)}</td><td class="num">${num(b.avgPosition)}</td><td class="num">${pct(b.recommendedRate)}</td><td class="num">${b.tone != null ? num(b.tone) : '<span class="muted">—</span>'}</td><td class="num">${b.firstPlace}</td>
        ${engines.map((e) => `<td class="num small">${b.byEngine[e] ? pct(b.byEngine[e]) : '—'}</td>`).join('')}
        <td class="num">${!b.own && !b.tracked ? `<button class="btn sm" data-track="${esc(b.brand)}">Urmărește</button>` : ''}</td></tr>
        ${state.openBrand === i ? `<tr><td colspan="${8 + engines.length}"><div class="attrs">${b.attributes.length ? b.attributes.map((x) => `<span class="attr ${x.polarity}">${esc(x.text)} <b>${x.count}</b></span>`).join('') : '<span class="muted small">Fără atribute extrase (rulează cu analiză AI pentru detalii).</span>'}</div></td></tr>` : ''}`).join('')}
      </tbody></table></div></section>`;
  bindRunButtons(p, () => viewCompetitors(p));
  main.querySelectorAll('tr[data-b]').forEach((tr) => tr.onclick = (ev) => { if (ev.target.closest('button')) return; const i = Number(tr.dataset.b); state.openBrand = state.openBrand === i ? null : i; viewCompetitors(p); });
  main.querySelectorAll('[data-track]').forEach((b) => b.onclick = async () => {
    const name = b.dataset.track;
    await api(`/api/projects/${p.id}`, { method: 'PUT', body: { competitors: [...p.competitors, { name }] } });
    toast(`${name} adăugat la competitori. Re-analizez răspunsurile…`);
    await api(`/api/projects/${p.id}/reanalyze`, { method: 'POST' });
    router();
  });
  poll(d, () => viewCompetitors(p));
}

// ───────────────────────────── Prompt Lab
function md(text, p, brands = []) {
  let h = esc(text);
  h = h.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/\[(\d+)\]/g, '<sup>[$1]</sup>');
  h = h.replace(/\[([^\]]+)\]\((https?:[^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const lines = h.split('\n');
  let out = '', inList = false;
  for (const l of lines) {
    const li = l.match(/^\s*(?:\d+[.)]|[-*•])\s+(.*)$/);
    if (li) { if (!inList) { out += '<ol>'; inList = true; } out += `<li>${li[1]}</li>`; continue; }
    if (inList) { out += '</ol>'; inList = false; }
    out += l.trim() ? `<p>${l.replace(/^#{1,4}\s*/, '')}</p>` : '';
  }
  if (inList) out += '</ol>';
  const groups = [[p.name, ...p.aliases], ...p.competitors.map((c) => [c.name, ...(c.aliases || [])]), ...brands.filter((b) => !b.tracked).map((b) => [b.name])];
  groups.forEach((group, gi) => group.filter((n) => n && n.length > 2).forEach((n) => {
    const re = new RegExp(`(?![^<]*>)(${esc(n).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi');
    out = out.replace(re, `<mark class="${gi === 0 ? 'own' : 'comp'}">$1</mark>`);
  }));
  return out;
}

async function viewPrompts(p) {
  const [prompts, d] = await Promise.all([api(`/api/projects/${p.id}/prompts`), getDash(p)]);
  const rows = new Map(d.metrics.prompts.map((r) => [r.promptId, r]));
  const engines = sortEngines(Object.keys(d.metrics.byEngine));
  const topics = [...new Set(prompts.map((q) => q.topic || q.tags[0] || 'General'))];
  const f = state.promptFilter;
  const list = prompts.filter((q) => (!f.topic || (q.topic || q.tags[0] || 'General') === f.topic) && (!f.intent || q.intent === f.intent));
  const ai = META.analysis?.enabled;
  main.innerHTML = `
    <div class="head"><div><h1>Prompturi și răspunsuri</h1><p class="sub">${prompts.filter((q) => q.active).length} prompturi active în ${topics.length} topicuri. Celulele arată în câte răspunsuri apari din câte rulări.</p></div>
      <div class="row">${jobsBar(d)}<button class="btn" id="aiGen" ${ai ? '' : 'disabled title="Necesită o cheie AI validă"'}>Generează prompturi cu AI</button><button class="btn" id="regen">Din șabloane</button><button class="btn primary" id="runNow" ${d.jobs.some((j) => j.type === 'run') ? 'disabled' : ''}>Rulează acum</button></div></div>
    ${runBanner(d, p)}
    <section class="panel" style="margin-bottom:20px"><h2>Topicuri</h2>
      <div class="body"><table class="t"><thead><tr><th>Topic</th><th class="num">Prompturi</th><th>Vizibilitatea ta</th><th>Lider</th><th class="num">Locul tău</th></tr></thead><tbody>
      ${d.analytics.topics.map((t) => `<tr class="click" data-topic="${esc(t.topic)}"><td>${esc(t.topic)}</td><td class="num">${t.prompts}</td><td style="width:30%"><div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar grow"><i style="width:${pct(t.visibility)}"></i></div><span class="small">${t.n ? pct(t.visibility) : '—'}</span></div></td><td class="small">${esc(t.leader)}</td><td class="num">${t.ownRank ?? '—'}</td></tr>`).join('')}
      </tbody></table></div></section>
    <div class="split wide">
      <section class="panel">
        <div class="filters" style="margin-top:0">
          <select id="fTopic"><option value="">Toate topicurile</option>${topics.map((t) => `<option ${f.topic === t ? 'selected' : ''}>${esc(t)}</option>`).join('')}</select>
          <select id="fIntent"><option value="">Toate intențiile</option>${Object.entries(INTENT).map(([k, v]) => `<option value="${k}" ${f.intent === k ? 'selected' : ''}>${v}</option>`).join('')}</select>
          <span class="muted small" style="align-self:center">${list.length} prompturi</span>
        </div>
        <form class="row" id="addP" style="margin:10px 0 12px"><input type="text" name="text" placeholder="Adaugă o întrebare, așa cum ar pune-o un client" style="flex:1;min-width:220px">
          <select name="topic" style="width:auto">${topics.map((t) => `<option>${esc(t)}</option>`).join('')}</select><button class="btn">Adaugă</button></form>
        <table class="t"><thead><tr><th>Prompt</th>${engines.map((e) => `<th>${engLabel(e)}</th>`).join('')}<th></th></tr></thead><tbody>
        ${list.map((q) => {
          const r = rows.get(q.id);
          return `<tr class="click ${state.promptSel === q.id ? 'sel' : ''}" data-pid="${q.id}" style="${q.active ? '' : 'opacity:.5'}"><td><div>${esc(q.text)}</div><div class="muted small">${esc(q.topic || q.tags[0] || '')} · ${INTENT[q.intent] || q.intent}${q.stage ? ` · ${STAGE[q.stage]}` : ''}${q.lang === 'en' ? ' · EN' : ''}${q.origin === 'ai' ? ' · <span class="tag ai">AI</span>' : ''}${r?.volatile ? ' · <span title="Rezultat diferit între repetări">variabil</span>' : ''}${r && r.visibility === 0 && r.winners.length ? ` · apar: ${esc(r.winners.slice(0, 2).map((w) => w.brand).join(', '))}` : ''}</div></td>
            ${engines.map((e) => { const c = r?.perEngine[e]; return `<td>${c ? `<span class="cell ${c.mentioned === c.n ? 'full' : c.mentioned ? 'hit' : ''}">${c.mentioned}/${c.n}</span>` : '<span class="muted small">—</span>'}</td>`; }).join('')}
            <td class="acts"><button class="btn ghost sm" data-toggle="${q.id}">${q.active ? 'Pauză' : 'Pornește'}</button><button class="btn ghost sm danger" data-del="${q.id}">Șterge</button></td></tr>`;
        }).join('')}</tbody></table>
      </section>
      <section class="sticky" id="detail"><div class="panel"><h2>Răspunsurile AI</h2><p class="muted" style="margin-top:6px">Alege un prompt ca să vezi exact ce au răspuns motoarele, ce branduri au numit, ce spun despre fiecare, ce au căutat în fundal și ce surse au citat.</p></div></section>
    </div>`;
  bindRunButtons(p, () => viewPrompts(p));
  $('#fTopic').onchange = (e) => { f.topic = e.target.value; viewPrompts(p); };
  $('#fIntent').onchange = (e) => { f.intent = e.target.value; viewPrompts(p); };
  main.querySelectorAll('tr[data-topic]').forEach((tr) => tr.onclick = () => { f.topic = tr.dataset.topic; viewPrompts(p); });
  $('#regen').onclick = async () => { await api(`/api/projects/${p.id}/prompts/generate`, { method: 'POST', body: { replace: false } }); toast('Am adăugat prompturi din șabloane'); viewPrompts(p); };
  $('#aiGen').onclick = () => openAiPrompts(p, topics);
  $('#addP').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    if (!fd.get('text')) return;
    await api(`/api/projects/${p.id}/prompts`, { method: 'POST', body: { text: fd.get('text'), intent: 'category', topic: fd.get('topic') } });
    viewPrompts(p);
  };
  main.querySelectorAll('[data-toggle]').forEach((b) => b.onclick = async (ev) => { ev.stopPropagation(); const q = prompts.find((x) => x.id === b.dataset.toggle); await api(`/api/prompts/${q.id}`, { method: 'PUT', body: { active: !q.active } }); viewPrompts(p); });
  main.querySelectorAll('[data-del]').forEach((b) => b.onclick = async (ev) => { ev.stopPropagation(); if (confirm('Ștergi promptul? Rezultatele vechi rămân în istoric.')) { await api(`/api/prompts/${b.dataset.del}`, { method: 'DELETE' }); viewPrompts(p); } });
  main.querySelectorAll('tr[data-pid]').forEach((tr) => tr.onclick = () => showPrompt(p, prompts.find((q) => q.id === tr.dataset.pid)));
  if (state.promptSel && prompts.some((q) => q.id === state.promptSel)) showPrompt(p, prompts.find((q) => q.id === state.promptSel));
  poll(d, () => viewPrompts(p));
}

function openAiPrompts(p, topics) {
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="box" role="dialog" aria-modal="true"><header><h2>Generează prompturi cu AI</h2><button class="btn" id="close">Închide</button></header><div class="content">
    <p class="muted small" style="margin-top:0">AI-ul scrie întrebări realiste, cum le tastează cumpărătorii, pe topicurile alese, cu intenții și etape diferite. Numele brandului tău nu apare niciodată în ele.</p>
    <form id="aiForm" class="stack" style="gap:12px">
      <div class="row">${topics.map((t) => `<label class="check"><input type="checkbox" name="topic" value="${esc(t)}" checked> ${esc(t)}</label>`).join('')}</div>
      <label class="f" style="max-width:220px">Prompturi per topic<input type="number" name="perTopic" min="1" max="10" value="4"></label>
      <label class="check"><input type="checkbox" name="replace" checked> Înlocuiește prompturile din șabloane care nu au rezultate</label>
      <div class="row"><button class="btn primary">Generează</button><span class="muted small" id="aiStatus"></span></div>
    </form></div></div>`;
  $('#close').onclick = () => (modal.hidden = true);
  $('#aiForm').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    ev.submitter.disabled = true;
    $('#aiStatus').innerHTML = '<span class="job"><span class="dot"></span>Generez… (10–40 secunde)</span>';
    try {
      const r = await api(`/api/projects/${p.id}/prompts/ai`, { method: 'POST', body: { topics: fd.getAll('topic'), perTopic: Number(fd.get('perTopic')), replaceTemplates: !!fd.get('replace') } });
      modal.hidden = true;
      toast(r.error && !r.added ? r.error : `${r.added} prompturi noi (cost ~$${r.costUsd.toFixed(3)})`);
      viewPrompts(p);
    } catch (e) {
      $('#aiStatus').textContent = e.message;
      ev.submitter.disabled = false;
    }
  };
}

async function showPrompt(p, q) {
  state.promptSel = q.id;
  main.querySelectorAll('tr[data-pid]').forEach((tr) => tr.classList.toggle('sel', tr.dataset.pid === q.id));
  const det = $('#detail');
  det.innerHTML = `<div class="panel"><p class="muted">Se încarcă…</p></div>`;
  const results = await api(`/api/projects/${p.id}/results?promptId=${q.id}`);
  const byEng = new Map();
  for (const r of results) if (!byEng.has(r.engine)) byEng.set(r.engine, r);
  det.innerHTML = `<div class="panel"><h2>${esc(q.text)}</h2><p class="muted small" style="margin-top:4px">Cel mai recent răspuns pe fiecare motor. ${results.length} răspunsuri în total.${q.intent !== 'brand' ? ` <a href="#/p/${p.id}/optimize?prompt=${q.id}">Optimizează o pagină pentru această întrebare</a>` : ''}</p>
    <div class="body">${sortEngines([...byEng.keys()]).map((e) => {
      const r = byEng.get(e);
      const x = r.extraction;
      const brands = x?.brands || [];
      return `<div class="answer"><div class="row"><b>${engLabel(r.engine)}</b><span class="muted small">${esc(r.model)}, ${fmtDate(r.createdAt)}${r.persona ? `, ca „${esc(r.persona)}”` : ''}${r.simulated ? ', simulat' : ''}${x?.analysis === 'llm' ? ', analizat cu AI' : ''}</span><span class="grow"></span>
        ${r.error ? `<span class="tag" style="background:var(--bad-soft);color:var(--bad)">Eroare</span>` : x.ownMentioned ? `<span class="tag you">Locul ${x.ownPosition}${x.ownRecommended ? ', recomandat' : ''}</span>` : `<span class="tag" style="background:var(--bad-soft);color:var(--bad)">Nu apari</span>`}</div>
        ${r.error ? `<p class="small" style="margin-top:8px;color:var(--bad)">${esc(r.error)}</p>` : `
          ${brands.length ? `<div class="brandline">${brands.slice(0, 8).map((b) => `<span class="bchip ${b.own ? 'own' : ''}" title="${esc(b.attributes.map((a) => a.text).join(', '))}">${b.position}. ${esc(b.name)}${b.recommended ? ' ✓' : ''}</span>`).join('')}</div>` : ''}
          <div class="txt">${md(r.text, p, brands)}</div>`}
        ${x?.accuracy?.length ? `<div class="banner" style="margin:10px 0 0">Date greșite despre tine: ${x.accuracy.map((a) => `${a.field === 'phone' ? 'telefon' : 'adresă'} „${esc(a.found)}” în loc de „${esc(a.expected)}”`).join('; ')}</div>` : ''}
        ${r.searchQueries?.length ? `<div class="small muted" style="margin-top:10px">A căutat: ${r.searchQueries.slice(0, 6).map((s) => `<span class="qchip">${esc(s)}</span>`).join(' ')}</div>` : ''}
        ${r.citations.length ? `<div class="cits">${r.citations.filter((c) => c.kind === 'cited').slice(0, 14).map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener" class="${c.domain.endsWith(p.domain) ? 'own' : ''}" title="${esc(c.title || c.url)}">${esc(c.domain)}</a>`).join('')}</div>` : ''}
      </div>`;
    }).join('') || '<p class="muted">Promptul nu a fost rulat încă.</p>'}</div></div>`;
}

// ───────────────────────────── Surse
async function viewSources(p) {
  const d = await getDash(p);
  const s = d.sources;
  const a = d.analytics;
  const groups = Object.entries(s.groupShare || {}).sort((x, y) => y[1] - x[1]);
  const gl = META.sourceGroupLabels || {};
  const filt = state.srcFilter;
  const rows = s.rows.filter((r) => !filt || r.group === filt);
  main.innerHTML = `
    <div class="head"><div><h1>Surse citate</h1><p class="sub">Paginile pe care AI-ul le citează când răspunde la întrebările tale. Brandurile numite sunt cele care apar clar în aceste pagini.</p></div></div>
    <div class="kpis k4">
      <div class="kpi"><div class="v">${s.answersWithCitations}</div><div class="l">Răspunsuri cu surse</div></div>
      <div class="kpi"><div class="v">${pct(s.ownShare)}</div><div class="l">Răspunsuri care citează site-ul tău</div></div>
      <div class="kpi"><div class="v">${pct(a.mentionsWithSource)}</div><div class="l">Mențiuni ale tale însoțite de link spre tine</div></div>
      <div class="kpi"><div class="v">${pct(a.localTldShare)}</div><div class="l">Linkuri pe .${esc((p.country || 'ro').toLowerCase())}</div></div>
    </div>
    <section class="panel" style="margin-bottom:20px"><h2>Tipuri de surse</h2><p class="muted small">Ponderea linkurilor afișate, pe tip. Click pe un tip ca să filtrezi tabelul.</p>
      <div class="body"><div style="display:flex;height:18px;border-radius:4px;overflow:hidden">${groups.map(([g, v], i) => `<span title="${esc(gl[g] || g)}: ${pct(v)}" style="width:${v * 100}%;background:${COLORS[i % COLORS.length]}"></span>`).join('')}</div>
      <div class="legend">${groups.map(([g, v], i) => `<span class="click ${filt === g ? 'on' : ''}" data-g="${g}"><i style="background:${COLORS[i % COLORS.length]}"></i>${esc(gl[g] || g)} ${pct(v, 1)}</span>`).join('')}${filt ? '<span class="click" data-g="">× toate</span>' : ''}</div></div></section>
    <section class="panel" style="margin-bottom:20px"><h2>Domenii${filt ? `: ${esc(gl[filt] || filt)}` : ''}</h2><p class="muted small">„Oportunitate” crește când sursa e citată des și în răspunsurile ei apar alții, dar nu tu. Click pe rând pentru URL-uri.</p>
      <div class="body"><table class="t"><thead><tr><th>Domeniu</th><th>Tip</th><th class="num">% răspunsuri</th><th>Motoare</th><th class="num">Cu tine</th><th class="num">Fără tine</th><th style="width:140px">Oportunitate</th></tr></thead><tbody>
      ${rows.map((r, i) => `<tr class="click" data-i="${i}"><td><b>${esc(r.domain)}</b></td><td class="small">${META.sourceTypeLabels[r.type] || r.type}</td><td class="num">${pct(r.share)}</td><td class="small">${sortEngines(r.engines).map(engLabel).join(', ')}</td><td class="num">${r.withOwn}</td><td class="num">${r.withCompetitors}</td>
        <td>${['owned', 'competitor', 'brand'].includes(r.type) ? `<span class="tag ${r.type === 'owned' ? 'you' : 'comp'}">${r.type === 'owned' ? 'site-ul tău' : 'site de brand'}</span>` : `<div class="row" style="gap:8px;flex-wrap:nowrap"><div class="bar comp grow"><i style="width:${r.gapScore}%"></i></div><span class="small">${r.gapScore}</span></div>`}</td></tr>
        <tr hidden data-urls="${i}"><td colspan="7" class="small">${r.urls.map((u) => `<div><a href="${esc(u.url)}" target="_blank" rel="noopener">${esc(u.title || u.url)}</a> <span class="muted">×${u.count}</span></div>`).join('')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nicio sursă încă. Rulează prompturile.</td></tr>'}
      </tbody></table></div></section>
    <div class="grid2">
      <section class="panel"><h2>Paginile tale citate</h2><p class="muted small">URL-urile de pe site-ul tău pe care AI-ul le folosește ca sursă.</p>
        <div class="body"><table class="t"><tbody>${a.ownCitedPages.map((x) => `<tr><td class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.title || x.url)}</a><div class="muted">${sortEngines(x.engines).map(engLabel).join(', ')} · ${x.prompts} prompturi</div></td><td class="num">${x.count}</td></tr>`).join('') || '<tr><td class="muted">Nicio pagină citată încă.</td></tr>'}</tbody></table>
        ${a.competitorCitedPages.length ? `<h3 style="margin-top:16px">Paginile competitorilor citate</h3><table class="t"><tbody>${a.competitorCitedPages.slice(0, 10).map((x) => `<tr><td class="small"><a href="${esc(x.url)}" target="_blank" rel="noopener">${esc(x.url)}</a><div class="muted">${esc(x.brand)}</div></td><td class="num">${x.count}</td></tr>`).join('')}</tbody></table>` : ''}</div></section>
      <section class="panel"><h2>Ce caută AI-ul în fundal</h2><p class="muted small">Interogările web („fan-out”) pe care motoarele le-au făcut ca să răspundă. Sunt cuvintele-cheie pentru care trebuie să existe conținut.</p>
        <div class="body"><table class="t"><tbody>${a.fanout.slice(0, 30).map((x) => `<tr><td>${esc(x.query)}</td><td class="small muted">${sortEngines(x.engines).map(engLabel).join(', ')}</td><td class="num">${x.count}</td></tr>`).join('') || '<tr><td class="muted">Fără date (Perplexity nu raportează interogările).</td></tr>'}</tbody></table></div></section>
    </div>`;
  main.querySelectorAll('tr[data-i]').forEach((tr) => tr.onclick = () => { const u = main.querySelector(`tr[data-urls="${tr.dataset.i}"]`); u.hidden = !u.hidden; });
  main.querySelectorAll('[data-g]').forEach((x) => x.onclick = () => { state.srcFilter = x.dataset.g; viewSources(p); });
}

// ───────────────────────────── Percepție
async function viewPerception(p) {
  const d = await getDash(p);
  const a = d.analytics;
  const own = a.brands.find((b) => b.own) || {};
  const comps = a.brands.filter((b) => !b.own && b.attributes.length).slice(0, 4);
  const per = a.perception;
  main.innerHTML = `
    <div class="head"><div><h1>Percepție</h1><p class="sub">Ce spune AI-ul despre ${esc(p.name)} când te recomandă: tonul, calitățile și reproșurile care apar în răspunsuri.${a.analysisMix.llm ? '' : ' Pentru atribute detaliate activează analiza AI (cheie validă), altfel se folosesc doar regulile de bază.'}</p></div></div>
    <div class="kpis k4">
      <div class="kpi lead"><div class="v">${own.tone != null ? num(own.tone) : '—'}</div><div class="l">Ton mediu (0–10)</div><div class="ci">${own.toneN} răspunsuri</div></div>
      ${sortEngines(Object.keys(per.toneByEngine)).slice(0, 3).map((e) => `<div class="kpi"><div class="v">${num(per.toneByEngine[e])}</div><div class="l">Ton în ${engLabel(e)}</div></div>`).join('')}
    </div>
    <div class="grid2">
      <section class="panel"><h2>Ce apreciază</h2><p class="muted small">Atribute pozitive asociate cu tine, după frecvență.</p><div class="body">${per.pos.length ? hbars(per.pos.map((x) => ({ label: x.text, value: x.count })), { fmt: (v) => String(v), color: 'var(--ok)' }) : '<p class="muted">Încă nimic.</p>'}</div></section>
      <section class="panel"><h2>Ce reproșează</h2><p class="muted small">Atribute negative. Fiecare e un subiect de conținut, de răspuns la recenzii sau de corectat în surse.</p><div class="body">${per.neg.length ? hbars(per.neg.map((x) => ({ label: x.text, value: x.count })), { fmt: (v) => String(v), color: 'var(--bad)' }) : '<p class="muted">Nicio mențiune negativă găsită.</p>'}</div></section>
    </div>
    ${comps.length ? `<section class="panel" style="margin-top:20px"><h2>Cum sunt descriși competitorii</h2><p class="muted small">Atributele care îi fac pe ceilalți aleși. Unde ei au un atribut și tu nu, ai o temă de conținut.</p>
      <div class="body grid3">${comps.map((c) => `<div><h3>${esc(c.brand)}</h3><div class="attrs" style="margin-top:8px">${c.attributes.slice(0, 6).map((x) => `<span class="attr ${x.polarity}">${esc(x.text)} <b>${x.count}</b></span>`).join('')}</div></div>`).join('')}</div></section>` : ''}
    <section class="panel" style="margin-top:20px"><h2>Citate din răspunsuri</h2>
      <div class="body">${per.quotes.map((x) => `<blockquote class="quote"><div>${esc(x.text).replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>').replace(/^\s*(\d+[.)]|[-*•])\s*/, '')}</div><div class="muted small">${engLabel(x.engine)} · ton ${num(x.sentiment)} · „${esc(x.prompt)}”</div></blockquote>`).join('') || '<p class="muted">Nu apari încă în răspunsuri.</p>'}</div></section>`;
}

// ───────────────────────────── Audit și acțiuni
async function viewActions(p) {
  const [d, a] = await Promise.all([getDash(p), api(`/api/projects/${p.id}/actions`)]);
  const audit = d.audit;
  const f = state.actFilter;
  const isDone = (s) => s === 'done' || s === 'verified';
  const items = a.items.filter((i) => (!f.priority || i.priority === f.priority) && (!f.category || i.category === f.category) && (f.status === 'all' || (f.status === 'open' ? !isDone(i.state.status) && i.state.status !== 'wontfix' : isDone(i.state.status))));
  const ip = a.items.filter((i) => i.state.status === 'in_progress').length;
  const findings = audit?.findings || [];
  // Dacă și Googlebot/Bingbot falși sunt respinși, WAF-ul verifică boții după IP → testul cu user-agent e neconcludent.
  const ctlBots = (audit?.bots || []).filter((b) => (b.token === 'Googlebot' || b.token === 'Bingbot') && b.liveStatus !== undefined);
  const wafVerifies = ctlBots.length > 0 && ctlBots.every((b) => b.liveBlocked);
  const stIcon = { pass: '✓', warn: '!', fail: '✕', manual: '○', na: '–' };
  const ai = META.analysis?.enabled;
  main.innerHTML = `
    <div class="head"><div><h1>Audit și acțiuni</h1><p class="sub">${audit ? `Site analizat: ${esc(audit.url)}, ${audit.pagesCrawled} pagini, ${fmtDate(audit.finishedAt)}.` : 'Site-ul nu a fost auditat încă.'}</p></div>
      <div class="row">${jobsBar(d)}<button class="btn" id="aiIns" ${ai && d.metrics.overall.n ? '' : `disabled title="${ai ? 'Rulează întâi prompturile' : 'Necesită o cheie AI validă'}"`}>Recomandări AI din date</button><button class="btn" id="auditNow" ${d.jobs.some((j) => j.type === 'audit') ? 'disabled' : ''}>Audit nou</button></div></div>
    ${auditBanner(d, p)}
    ${a.insightsAt ? `<div class="banner info">Include ${a.items.filter((i) => i.aiGenerated).length} recomandări generate cu AI din datele proiectului (${fmtDate(a.insightsAt)}), marcate „AI”.</div>` : ''}
    <div class="grid2" style="margin-bottom:20px">
      <section class="panel"><h2>Scor GEO</h2><p class="muted small">Se recalculează la fiecare bifă și la fiecare rulare de prompturi.</p>
        <div class="body score"><div class="big">${audit ? audit.score : '—'}<small> / 100</small></div>
        <div class="pillars">${audit ? Object.entries(audit.pillarScores).map(([k, v]) => `<div class="pillar"><span>${META.pillarLabels[k]}</span><div class="bar"><i style="width:${v.max ? (v.score / v.max) * 100 : 0}%;background:${v.max && v.score / v.max < 0.4 ? 'var(--bad)' : v.max && v.score / v.max < 0.7 ? '#e9b949' : 'var(--ok)'}"></i></div><span class="small num">${v.score}/${v.max}</span></div>`).join('') : '<p class="muted">Pornește un audit ca să vezi scorul pe piloni.</p>'}</div></div></section>
      <section class="panel"><h2>Progres</h2><p class="muted small">Câte dintre lucrurile recomandate sunt deja făcute.</p>
        <div class="body"><div class="progress"><b>${a.progress.done} din ${a.progress.total}</b><span class="muted">finalizate${ip ? `, ${ip} în lucru` : ''}</span></div>
        <div class="progressbar"><i style="width:${(a.progress.done / Math.max(1, a.progress.total)) * 100}%"></i><i class="ip" style="width:${(ip / Math.max(1, a.progress.total)) * 100}%"></i></div>
        <table class="t" style="margin-top:12px"><tbody>${['P0', 'P1', 'P2'].map((k) => { const b = a.progress.byPriority[k] || { done: 0, total: 0 }; return `<tr><td><span class="tag ${k}">${k}</span> <span class="small muted">${{ P0: 'acum', P1: 'luna aceasta', P2: 'apoi' }[k]}</span></td><td class="num">${b.done} / ${b.total}</td></tr>`; }).join('')}</tbody></table></div></section>
    </div>
    <section class="panel">
      <h2>Plan de acțiuni</h2><p class="muted small">Fiecare acțiune are motivul, pașii exacți și cum verifici că e gata. Bifează când e implementată; scorul se actualizează.</p>
      <div class="filters">
        <select id="fStatus"><option value="open">Deschise</option><option value="done">Finalizate</option><option value="all">Toate</option></select>
        <select id="fPrio"><option value="">Toate prioritățile</option><option>P0</option><option>P1</option><option>P2</option></select>
        <select id="fCat"><option value="">Toate categoriile</option>${Object.entries(CAT).map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
        <span class="muted small" style="align-self:center">${items.length} acțiuni</span>
      </div>
      <div class="actions">${items.map((i) => actionRow(i)).join('') || '<p class="muted" style="padding:12px 0">Nicio acțiune pentru filtrele alese.</p>'}</div>
    </section>
    ${audit ? `<div class="grid2" style="margin-top:20px">
      <section class="panel"><h2>Toate verificările</h2><p class="muted small">${findings.filter((x) => x.status === 'pass').length} trecute din ${findings.filter((x) => x.status !== 'na').length}.</p>
        <div class="body"><table class="t"><tbody>${findings.map((x) => `<tr><td class="st-${x.status}" style="width:22px;font-weight:700">${stIcon[x.status]}</td><td><div>${esc(x.title)}</div><div class="muted small">${esc(x.detail)}</div></td><td class="small muted">${META.pillarLabels[x.pillar]}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel"><h2>Acces pentru boții AI</h2><p class="muted small">robots.txt și un test real cu user-agent-ul fiecărui bot, comparat cu răspunsul primit de un browser. Boții de antrenare sunt o decizie de business.</p>
        <div class="body"><table class="t"><thead><tr><th>Bot</th><th>Rol</th><th>robots.txt</th><th>Test live</th></tr></thead><tbody>
        ${audit.bots.map((b) => `<tr><td><b>${esc(b.token)}</b><div class="muted small">${esc(b.operator)}</div></td><td class="small">${{ search: 'Căutare / citare', user: 'Vizită la cerere', training: 'Antrenare' }[b.purpose]}</td>
          <td class="${b.robotsAllowed ? 'st-pass' : b.purpose === 'training' ? 'st-warn' : 'st-fail'}">${b.robotsAllowed ? 'permis' : 'blocat'}${b.robotsLine ? `<div class="muted small">${esc(b.robotsLine)}</div>` : ''}</td>
          <td class="${b.liveBlocked ? (wafVerifies ? 'st-warn' : 'st-fail') : 'st-pass'}">${b.liveStatus === undefined ? '<span class="muted">—</span>' : b.liveBlocked ? `${wafVerifies ? 'respins (UA fals)' : 'blocat'}<div class="muted small">${esc(b.liveReason || `HTTP ${b.liveStatus}`)}</div>` : `OK (HTTP ${b.liveStatus})`}</td></tr>`).join('')}
        </tbody></table>${wafVerifies ? `<p class="small" style="margin-top:10px">Site-ul respinge și Googlebot/Bingbot falși, deci WAF-ul verifică boții după IP. Testul cu user-agent nu poate confirma blocarea reală; verificați logurile în tab-ul <a href="#/p/${p.id}/crawlers">Crawlere AI</a>.</p>` : ''}${audit.notes?.length ? `<p class="muted small" style="margin-top:10px">${audit.notes.map(esc).join(' ')}</p>` : ''}</div></section>
    </div>` : ''}`;
  $('#fStatus').value = f.status; $('#fPrio').value = f.priority; $('#fCat').value = f.category;
  $('#fStatus').onchange = (e) => { f.status = e.target.value; viewActions(p); };
  $('#fPrio').onchange = (e) => { f.priority = e.target.value; viewActions(p); };
  $('#fCat').onchange = (e) => { f.category = e.target.value; viewActions(p); };
  $('#aiIns').onclick = async (ev) => {
    ev.target.disabled = true;
    ev.target.textContent = 'Analizez datele… (20–60 s)';
    try {
      const r = await api(`/api/projects/${p.id}/insights`, { method: 'POST' });
      toast(r.count ? `${r.count} recomandări AI adăugate (cost ~$${r.costUsd.toFixed(3)})` : r.error || 'Nicio recomandare generată');
    } catch (e) { toast(e.message); }
    viewActions(p);
  };
  bindRunButtons(p, () => viewActions(p));
  bindActions(p, a.items);
  poll(d, () => viewActions(p));
}

function actionRow(i) {
  const s = i.state.status;
  const open = state.openAct.has(i.key);
  const done = s === 'done' || s === 'verified';
  return `<div class="act ${done ? 'done' : ''}" data-key="${esc(i.key)}">
    <button class="tick ${done ? 'done' : s === 'in_progress' ? 'ip' : ''}" data-tick="${esc(i.key)}" aria-label="${done ? 'Marchează ca nefăcut' : 'Marchează ca făcut'}" title="${STATUS[s]}">${done ? '✓' : ''}</button>
    <div><div class="ttl" data-open="${esc(i.key)}">${esc(i.title)}</div>
      <div class="meta"><span class="tag ${i.priority}">${i.priority}</span>${i.aiGenerated ? '<span class="tag ai">AI</span>' : ''}<span>${CAT[i.category] || i.category}</span>${i.impact ? `<span title="Impact × Gap × Încredere ÷ Efort">impact ${i.impact}, efort ${i.effort}</span>` : ''}${i.manual ? '<span>verificare manuală</span>' : ''}${i.state.owner ? `<span>responsabil: ${esc(i.state.owner)}</span>` : ''}${s === 'in_progress' ? '<span style="color:var(--warn)">în lucru</span>' : ''}</div></div>
    <div class="row">${i.generator ? `<button class="btn sm" data-gen="${i.generator}" data-arg="${esc(i.generatorArg || '')}">${GEN_LABEL[i.generator]}</button>` : ''}</div>
    ${open ? `<div class="more">
      <div><p>${esc(i.why)}</p>${i.steps.length ? `<ol>${i.steps.map((x) => `<li>${esc(x)}</li>`).join('')}</ol>` : ''}${i.acceptance ? `<p class="small"><b>Gata când:</b> ${esc(i.acceptance)}</p>` : ''}</div>
      <div class="stack" style="gap:10px">
        ${i.evidence.length ? `<div class="ev"><b style="color:var(--ink)">Dovezi</b>${i.evidence.slice(0, 6).map((e) => `<div>${esc(e)}</div>`).join('')}</div>` : ''}
        <label class="f">Status<select data-status="${esc(i.key)}">${Object.entries(STATUS).map(([k, v]) => `<option value="${k}" ${k === s ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
        <label class="f">Responsabil<input type="text" data-owner="${esc(i.key)}" value="${esc(i.state.owner)}" placeholder="Agenția / client / nume"></label>
        <label class="f">Dovadă (URL publicat)<input type="url" data-evidence="${esc(i.key)}" value="${esc(i.state.evidenceUrl)}" placeholder="https://"></label>
      </div></div>` : ''}
  </div>`;
}

function bindActions(p, items) {
  const save = async (key, patch) => { const it = items.find((x) => x.key === key); await api(`/api/projects/${p.id}/actions`, { method: 'PUT', body: { key, title: it?.title, ...patch } }); };
  main.querySelectorAll('[data-tick]').forEach((b) => b.onclick = async () => {
    const it = items.find((x) => x.key === b.dataset.tick);
    const done = it.state.status === 'done' || it.state.status === 'verified';
    await save(it.key, { status: done ? 'todo' : 'done' });
    toast(done ? 'Redeschisă' : 'Marcată ca făcută');
    viewActions(p);
  });
  main.querySelectorAll('[data-open]').forEach((t) => t.onclick = () => { const k = t.dataset.open; state.openAct.has(k) ? state.openAct.delete(k) : state.openAct.add(k); viewActions(p); });
  main.querySelectorAll('[data-status]').forEach((s) => s.onchange = async () => { await save(s.dataset.status, { status: s.value }); viewActions(p); });
  main.querySelectorAll('[data-owner]').forEach((s) => s.onchange = async () => { await save(s.dataset.owner, { owner: s.value }); toast('Salvat'); });
  main.querySelectorAll('[data-evidence]').forEach((s) => s.onchange = async () => { await save(s.dataset.evidence, { evidenceUrl: s.value }); toast('Salvat'); });
  main.querySelectorAll('[data-gen]').forEach((b) => b.onclick = () => openGenerator(p, b.dataset.gen, b.dataset.arg));
}

async function openGenerator(p, kind, arg) {
  const modal = $('#modal');
  modal.hidden = false;
  modal.innerHTML = `<div class="box" role="dialog" aria-modal="true"><header><h2>Se generează…</h2></header></div>`;
  const g = await api(`/api/projects/${p.id}/generate/${kind}`, { method: 'POST', body: { arg } });
  modal.innerHTML = `<div class="box" role="dialog" aria-modal="true" aria-labelledby="gt"><header><h2 id="gt">${esc(g.title)}</h2><div class="row"><button class="btn primary" id="copy">Copiază</button><button class="btn" id="close">Închide</button></div></header>
    <div class="content">${g.notes.length ? `<ul class="small muted" style="margin-top:0">${g.notes.map((n) => `<li>${esc(n)}</li>`).join('')}</ul>` : ''}<pre>${esc(g.content)}</pre></div></div>`;
  const close = () => { modal.hidden = true; modal.innerHTML = ''; };
  $('#close').onclick = close;
  modal.onclick = (e) => { if (e.target === modal) close(); };
  $('#copy').onclick = async () => { await navigator.clipboard.writeText(g.content); toast('Copiat în clipboard'); };
  $('#copy').focus();
}

// ───────────────────────────── Optimizator de conținut
async function viewOptimize(p) {
  const [prompts, hist] = await Promise.all([api(`/api/projects/${p.id}/prompts`), api(`/api/projects/${p.id}/optimizations`)]);
  const pre = new URLSearchParams(location.hash.split('?')[1] || '').get('prompt');
  main.innerHTML = `
    <div class="head"><div><h1>Optimizator de conținut</h1><p class="sub">Compară o pagină de pe site-ul tău cu paginile pe care AI-ul le citează deja pentru aceeași întrebare și primești rescrierile concrete: răspuns direct, fapte lipsă, FAQ, structură.</p></div></div>
    <form class="panel form" id="optF">
      <label class="f full">Pagina de optimizat<input type="url" name="url" required placeholder="https://${esc(p.domain)}/..." value="https://${esc(p.domain)}/"></label>
      <label class="f">Întrebarea țintă (din prompturile urmărite)<select name="promptId"><option value="">— scriu eu întrebarea —</option>${prompts.filter((q) => q.intent !== 'brand').map((q) => `<option value="${q.id}" ${pre === q.id ? 'selected' : ''}>${esc(q.text)}</option>`).join('')}</select></label>
      <label class="f">sau întrebare liberă<input type="text" name="question" placeholder="Ex.: de unde cumpăr un laptop bun pentru programare?"></label>
      <div class="full row"><button class="btn primary">Analizează pagina</button><span class="muted small">${META.analysis?.enabled ? 'Include rescrieri generate cu AI.' : 'Fără cheie AI primești doar scorul determinist.'}</span></div>
    </form>
    <div id="optOut" style="margin-top:20px"></div>
    ${hist.length ? `<section class="panel" style="margin-top:20px"><h2>Analize anterioare</h2><div class="body"><table class="t"><tbody>${hist.map((h, i) => `<tr class="click" data-h="${i}"><td class="small">${esc(h.data.target.url)}<div class="muted">${esc(h.data.question)}</div></td><td class="num">${h.data.ai?.score ?? h.data.target.score}</td><td class="small muted">${fmtDate(h.createdAt)}</td></tr>`).join('')}</tbody></table></div></section>` : ''}`;
  main.querySelectorAll('tr[data-h]').forEach((tr) => tr.onclick = () => renderOpt(hist[Number(tr.dataset.h)].data));
  $('#optF').onsubmit = async (ev) => {
    ev.preventDefault();
    const fd = new FormData(ev.target);
    ev.submitter.disabled = true;
    $('#optOut').innerHTML = '<div class="panel"><span class="job"><span class="dot"></span>Citesc pagina și paginile citate de AI, apoi generez recomandările… (20–60 s)</span></div>';
    try {
      renderOpt(await api(`/api/projects/${p.id}/optimize`, { method: 'POST', body: { url: fd.get('url'), promptId: fd.get('promptId') || undefined, question: fd.get('question') || undefined } }));
    } catch (e) {
      $('#optOut').innerHTML = `<div class="banner bad">${esc(e.message)}</div>`;
    }
    ev.submitter.disabled = false;
  };
}

function renderOpt(r) {
  const cols = [r.target, ...r.competitors];
  const ai = r.ai;
  $('#optOut').innerHTML = `
    <section class="panel" style="margin-bottom:20px"><h2>„${esc(r.question)}”</h2><p class="muted small">Pagina ta (prima coloană) față de paginile citate de AI pentru această întrebare${r.competitors.length ? '' : ' — nu există încă pagini citate; rulează promptul ca să ai comparație'}.</p>
      <div class="body" style="overflow-x:auto"><table class="t"><thead><tr><th>Verificare</th>${cols.map((c, i) => `<th>${i === 0 ? '<b>Pagina ta</b>' : esc(new URL(c.url).hostname)}<div class="muted small" style="font-weight:400">${c.score}/100</div></th>`).join('')}</tr></thead><tbody>
      ${r.target.checks.map((ch, k) => `<tr><td>${esc(ch.label)}</td>${cols.map((c) => `<td class="${c.checks[k].ok ? 'st-pass' : 'st-fail'} small" title="${esc(c.checks[k].detail)}">${c.checks[k].ok ? '✓' : '✕'} <span class="muted">${esc(c.checks[k].detail.slice(0, 60))}</span></td>`).join('')}</tr>`).join('')}
      </tbody></table></div></section>
    ${ai ? `<div class="grid2">
      <section class="panel"><h2>Verdict AI: ${ai.score}/100</h2><p style="margin-top:8px">${esc(ai.verdict)}</p>
        <h3 style="margin-top:16px">Paragraf de răspuns direct (pune-l sus în pagină)</h3><pre class="copyable">${esc(ai.directAnswer)}</pre>
        <h3 style="margin-top:16px">Probleme și rezolvări</h3><ol>${(ai.issues || []).map((x) => `<li><b>${esc(x.issue)}</b><br><span class="muted">${esc(x.fix)}</span></li>`).join('')}</ol></section>
      <section class="panel"><h2>Fapte care lipsesc</h2><ul>${(ai.missingFacts || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li class="muted">—</li>'}</ul>
        <h3 style="margin-top:16px">Structură recomandată</h3><ol>${(ai.outline || []).map((x) => `<li>${esc(x)}</li>`).join('')}</ol>
        <h3 style="margin-top:16px">FAQ</h3>${(ai.faq || []).map((x) => `<p style="margin-top:8px"><b>${esc(x.q)}</b><br>${esc(x.a)}</p>`).join('')}</section>
    </div>` : `<div class="banner">${esc(r.aiError || 'Fără rescrieri AI.')}</div>`}`;
  document.querySelectorAll('pre.copyable').forEach((pre) => pre.onclick = async () => { await navigator.clipboard.writeText(pre.textContent); toast('Copiat'); });
}

// ───────────────────────────── Crawlere AI (loguri)
async function viewCrawlers(p) {
  const hist = await api(`/api/projects/${p.id}/logs`);
  main.innerHTML = `
    <div class="head"><div><h1>Crawlere AI</h1><p class="sub">Încarcă logurile de acces ale serverului ca să vezi cât de des vin boții AI, pe ce pagini, dacă sunt blocați și câți vizitatori vin din ChatGPT, Perplexity sau Gemini.</p></div></div>
    <section class="panel"><h2>Încarcă un fișier de log</h2><p class="muted small">Formate acceptate: IIS (W3C, cu linia #Fields), Apache/Nginx „combined”, Cloudflare Logpush (JSON pe linie). Fișierele .gz sunt acceptate. Fișierul se procesează în flux, deci poate fi mare.</p>
      <div class="body row"><input type="file" id="logFile" accept=".log,.txt,.gz,.json,.jsonl"><button class="btn primary" id="upload">Analizează</button><span id="upStatus" class="muted small"></span></div>
      <p class="small muted" style="margin-top:10px">IIS: <code>C:\\inetpub\\logs\\LogFiles\\W3SVC1\\</code>. Nginx: <code>/var/log/nginx/access.log</code>. Cloudflare: Logpush sau Logs Explorer → export.</p></section>
    <div id="logOut" style="margin-top:20px"></div>`;
  if (hist[0]) renderLogs(hist[0].data, hist[0].createdAt);
  $('#upload').onclick = async () => {
    const f = $('#logFile').files[0];
    if (!f) return toast('Alege un fișier');
    $('#upStatus').innerHTML = `<span class="job"><span class="dot"></span>Procesez ${(f.size / 1e6).toFixed(1)} MB…</span>`;
    try {
      const gz = /\.gz$/i.test(f.name);
      const res = await fetch(`/api/projects/${p.id}/logs${gz ? '?gz=1' : ''}`, { method: 'POST', body: f, headers: { 'content-type': 'application/octet-stream' } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      $('#upStatus').textContent = '';
      renderLogs(data, new Date().toISOString());
    } catch (e) {
      $('#upStatus').textContent = e.message;
    }
  };
}

function renderLogs(r, at) {
  const search = r.bots.filter((b) => b.purpose !== 'training');
  $('#logOut').innerHTML = `
    <div class="kpis k4">
      <div class="kpi"><div class="v">${r.parsed.toLocaleString('ro-RO')}</div><div class="l">Linii citite (${esc(r.format)})</div><div class="ci">${r.from ?? ''} – ${r.to ?? ''}</div></div>
      <div class="kpi"><div class="v">${r.bots.reduce((s, b) => s + b.hits, 0).toLocaleString('ro-RO')}</div><div class="l">Cereri de la boți AI</div></div>
      <div class="kpi"><div class="v">${r.bots.reduce((s, b) => s + b.blocked, 0)}</div><div class="l">Cereri blocate (401/403/429/503)</div></div>
      <div class="kpi"><div class="v">${r.aiReferrals.reduce((s, x) => s + x.visits, 0)}</div><div class="l">Vizite venite din asistenți AI</div></div>
    </div>
    <div class="grid2">
      <section class="panel"><h2>Boți AI</h2><p class="muted small">Analiză din ${fmtDate(at)}. ${search.length ? '' : 'Niciun bot de căutare AI în acest log.'}</p>
        <div class="body"><table class="t"><thead><tr><th>Bot</th><th>Rol</th><th class="num">Cereri</th><th class="num">Pagini</th><th class="num">Blocate</th></tr></thead><tbody>
        ${r.bots.map((b) => `<tr><td><b>${esc(b.token)}</b><div class="muted small">${esc(b.operator)}</div></td><td class="small">${{ search: 'Căutare', user: 'La cerere', training: 'Antrenare' }[b.purpose]}</td><td class="num">${b.hits}</td><td class="num">${b.pages}</td><td class="num ${b.blocked ? 'st-fail' : ''}">${b.blocked}</td></tr>`).join('') || '<tr><td class="muted">Niciun bot AI identificat.</td></tr>'}</tbody></table></div></section>
      <section class="panel"><h2>Trafic din asistenți AI</h2><p class="muted small">Vizite umane cu referrer ChatGPT, Perplexity, Gemini, Copilot etc. și paginile pe care au ajuns.</p>
        <div class="body">${r.aiReferrals.map((x) => `<h3>${esc(x.source)} <span class="muted small">${x.visits} vizite</span></h3><table class="t" style="margin-bottom:12px"><tbody>${x.topLanding.slice(0, 5).map((l) => `<tr><td class="small">${esc(l.path)}</td><td class="num">${l.visits}</td></tr>`).join('')}</tbody></table>`).join('') || '<p class="muted">Nicio vizită cu referrer AI în acest log.</p>'}</div></section>
    </div>
    <div class="grid2" style="margin-top:20px">
      <section class="panel"><h2>Paginile cele mai vizitate de boți AI</h2><div class="body"><table class="t"><tbody>${r.topPagesAllBots.map((x) => `<tr><td class="small">${esc(x.path)}</td><td class="num">${x.hits}</td></tr>`).join('')}</tbody></table></div></section>
      <section class="panel"><h2>Pagini importante nevizitate</h2><p class="muted small">Pagini din ultimul audit pe care niciun bot de căutare AI nu le-a cerut în perioada logului.</p><div class="body"><table class="t"><tbody>${r.notCrawled.map((x) => `<tr><td class="small">${esc(x)}</td></tr>`).join('') || '<tr><td class="muted">—</td></tr>'}</tbody></table></div></section>
    </div>`;
}

// ───────────────────────────── Raport
function viewReport(p) {
  const share = `${location.origin}/r/${p.shareToken}`;
  main.innerHTML = `<div class="head"><div><h1>Raport client</h1><p class="sub">Același raport se deschide fără cont, prin linkul de mai jos. Din browser îl salvezi ca PDF.</p></div>
    <div class="row"><a class="btn" href="/api/projects/${p.id}/export.csv">Export CSV</a><a class="btn" href="/api/projects/${p.id}/report" target="_blank" rel="noopener">Deschide în tab nou</a><button class="btn primary" id="copyLink">Copiază linkul public</button></div></div>
    <p class="small muted" style="margin-bottom:12px">Link public: <a href="${share}" target="_blank" rel="noopener">${esc(share)}</a></p>
    <iframe src="/api/projects/${p.id}/report" title="Raport" style="width:100%;height:78vh;border:1px solid var(--line);border-radius:8px;background:#fff"></iframe>`;
  $('#copyLink').onclick = async () => { await navigator.clipboard.writeText(share); toast('Link copiat'); };
}

// ───────────────────────────── Setări
function viewSettings(p) {
  main.innerHTML = `<div class="head"><div><h1>Setări proiect</h1><p class="sub">Modificările se aplică de la următoarea rulare. Pentru prompturi noi pe topicurile modificate folosește „Generează prompturi cu AI”.</p></div>
    <div class="row"><button class="btn" id="reanalyze">Re-analizează răspunsurile</button></div></div>
    <form class="form panel" id="pf">${projectForm(p)}
    <div class="full row"><button class="btn primary" type="submit">Salvează modificările</button><span class="grow"></span><button class="btn danger" type="button" id="del">Șterge proiectul</button></div></form>`;
  $('#pf').onsubmit = async (ev) => {
    ev.preventDefault();
    const body = readProjectForm(ev.target);
    await api(`/api/projects/${p.id}`, { method: 'PUT', body: { ...body, services: p.services } });
    toast('Modificările au fost salvate');
    router();
  };
  $('#reanalyze').onclick = async () => { await api(`/api/projects/${p.id}/reanalyze`, { method: 'POST' }); toast('Re-analiza a pornit în fundal (competitori noi, analiză AI)'); };
  $('#del').onclick = async () => {
    if (!confirm(`Ștergi definitiv proiectul „${p.name}” cu toate rezultatele? Acțiunea nu poate fi anulată.`)) return;
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    location.hash = '#/';
  };
}

router();
