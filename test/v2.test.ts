// Teste pentru stratul AI, analitică, loguri, crawler v2 și eșecul rapid la chei invalide.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { gzipSync } from 'node:zlib';
import { computeAnalytics } from '../src/core/analytics.ts';
import { canonicalUrl, crawlSite } from '../src/core/crawler.ts';
import { configFromEnv, testEngines } from '../src/core/engines.ts';
import { analyzeWithLLM, extract } from '../src/core/extract.ts';
import { parseJsonLoose } from '../src/core/llm.ts';
import { LogAnalyzer } from '../src/core/logs.ts';
import { pageSignals } from '../src/core/optimize.ts';
import { profileSite } from '../src/core/profile.ts';
import { generatePrompts, generatePromptsAI } from '../src/core/prompts.ts';
import type { Project } from '../src/core/types.ts';
import { Store } from '../src/server/db.ts';
import { Service } from '../src/server/service.ts';

const shop: Project = {
  id: 'p2', name: 'eMAG', domain: 'emag.ro', aliases: ['emag.ro'], vertical: 'ecommerce', scope: 'national', category: 'magazin online', country: 'RO', city: 'Iasi',
  neighborhoods: [], services: [], topics: [{ name: 'Laptopuri' }, { name: 'Electrocasnice' }], personas: [], languages: ['ro'], engines: ['claude'], repetitions: 1, schedule: 'manual',
  competitors: [{ name: 'Altex', domain: 'altex.ro' }, { name: 'Flanco' }], facts: {}, shareToken: 't', createdAt: new Date().toISOString(),
};

/** Interceptează fetch: API-urile LLM primesc răspunsuri fixe, restul (site-urile locale de test) merg normal. */
function mockLLM(handler: (host: string, body: any) => { status?: number; json: unknown }) {
  const orig = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
    const u = new URL(String(url));
    if (/api\.(openai|anthropic|perplexity)\.(com|ai)|generativelanguage/.test(u.hostname)) {
      const r = handler(u.hostname, init?.body ? JSON.parse(String(init.body)) : null);
      return new Response(JSON.stringify(r.json), { status: r.status ?? 200, headers: { 'content-type': 'application/json' } });
    }
    return orig(url, init);
  }) as typeof fetch;
  return () => (globalThis.fetch = orig);
}
const claudeText = (text: string) => ({ json: { model: 'claude-x', content: [{ type: 'text', text }], usage: { input_tokens: 100, output_tokens: 50 } } });

test('parseJsonLoose: extrage JSON din text cu fences și proză', () => {
  assert.deepEqual(parseJsonLoose('Iată:\n```json\n{"a":[1,{"b":"}"}]}\n```\nGata'), { a: [1, { b: '}' }] });
  assert.equal(parseJsonLoose('fără json'), null);
});

test('șabloane: magazin național fără oraș, pe topicuri, fără numele brandului', () => {
  const ps = generatePrompts(shop, 20);
  assert.ok(ps.some((x) => x.topic === 'Laptopuri'));
  assert.ok(ps.filter((x) => x.intent !== 'brand').every((x) => !/iasi/i.test(x.text) && !/emag/i.test(x.text)));
  assert.ok(!ps.some((x) => /\bprodusele pe care\b/.test(x.text)));
  const brand = ps.find((x) => x.intent === 'brand')!;
  assert.ok(!/din Iasi/.test(brand.text), 'promptul de brand nu include orașul la un magazin național');
});

test('prompturi AI: filtrează numele brandului și duplicatele', async () => {
  const restore = mockLLM(() => claudeText(JSON.stringify({ prompts: [
    { text: 'Unde găsesc cel mai bun laptop pentru programare în România?', topic: 'Laptopuri', intent: 'category', stage: 'awareness', lang: 'ro' },
    { text: 'Este eMAG de încredere pentru laptopuri?', topic: 'Laptopuri', intent: 'trust', stage: 'decision', lang: 'ro' },
    { text: 'Altex sau alte magazine pentru frigidere?', topic: 'Electrocasnice', intent: 'comparison', stage: 'decision', lang: 'ro' },
    { text: 'Unde găsesc cel mai bun laptop pentru programare în România?', topic: 'Laptopuri', intent: 'category', lang: 'ro' },
  ] })));
  try {
    const r = await generatePromptsAI(shop, configFromEnv({ ANTHROPIC_API_KEY: 'sk-ant-api-x' }), { perTopic: 2 });
    assert.equal(r.prompts.length, 2);
    assert.ok(r.prompts.every((x) => !/emag/i.test(x.text)));
    assert.equal(r.prompts[1].intent, 'comparison');
    assert.ok(r.costUsd > 0);
  } finally {
    restore();
  }
});

test('analiză LLM: branduri canonice, atribute, fără mențiune proprie inventată', async () => {
  const text = '1. **Altex** – prețuri bune și livrare rapidă.\n2. **Flanco** – ofertă bună.\n3. **evoMAG** – specializat pe IT.';
  const base = extract(text, [], shop);
  assert.equal(base.ownMentioned, false);
  const restore = mockLLM(() => claudeText(JSON.stringify({ brands: [
    { name: 'ALTEX', recommended: true, sentiment: 8, attributes: [{ text: 'prețuri bune', polarity: 'pos' }] },
    { name: 'Flanco', recommended: true, sentiment: 7, attributes: [] },
    { name: 'eMAG', recommended: true, sentiment: 9, attributes: [] }, // halucinație: nu e în text
    { name: 'evoMAG', recommended: true, sentiment: 7, attributes: [{ text: 'specializat pe IT', polarity: 'neu' }] },
  ] })));
  try {
    const r = await analyzeWithLLM(text, base, shop, configFromEnv({ ANTHROPIC_API_KEY: 'k' }));
    const ex = r.extraction;
    assert.equal(ex.analysis, 'llm');
    assert.equal(ex.brands![0].name, 'Altex');
    assert.equal(ex.brands![0].tracked, true);
    assert.ok(!ex.brands!.some((b) => b.own), 'mențiunea proprie neconfirmată textual e respinsă');
    assert.ok(ex.discovered.includes('evoMAG'));
  } finally {
    restore();
  }
});

test('atribute din reguli când nu există LLM', () => {
  const ex = extract('1. **Altex** – prețuri accesibile și livrare rapidă, dar unele reclamații la retur.', [], shop);
  const a = ex.brands!.find((b) => b.name === 'Altex')!;
  assert.ok(a.attributes.some((x) => x.text === 'prețuri bune' && x.polarity === 'pos'));
  assert.ok(a.attributes.some((x) => x.polarity === 'neg'));
});

test('crawler v2: sitemap .gz, deduplicare ?ref=, fără fals pozitiv WAF, pagini de coș ignorate', async () => {
  const xml = `<?xml version="1.0"?><urlset><url><loc>http://HOST/laptopuri</loc></url><url><loc>http://HOST/telefoane</loc></url><url><loc>http://HOST/cart</loc></url></urlset>`;
  let host = '';
  const srv = createServer((req, res) => {
    const ua = String(req.headers['user-agent']);
    const url = req.url ?? '/';
    if (url === '/robots.txt') return res.end(`User-agent: *\nAllow: /\nSitemap: http://${host}/sitemap.xml.gz`);
    if (url === '/sitemap.xml.gz') {
      res.writeHead(200, { 'content-type': 'application/x-gzip' });
      return res.end(gzipSync(xml.replaceAll('HOST', host)));
    }
    if (/PerplexityBot/.test(ua)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><head><title>Just a moment...</title></head><body>cf-chl</body></html>');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    const pad = '<p>' + 'conținut real '.repeat(300) + '</p>';
    // „captcha” apare în cod, ca pe multe site-uri mari — nu trebuie considerat blocaj
    res.end(`<html><head><title>Shop</title><script src="/js/recaptcha.js"></script></head><body><h1>Shop ${url}</h1>${pad}<a href="/laptopuri?ref=hdr">L</a><a href="/laptopuri?ref=footer">L2</a><a href="/cart?ref=x">Coș</a><a href="/telefoane">T</a></body></html>`);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  host = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
  try {
    const c = await crawlSite(`http://${host}`, { maxPages: 10 });
    assert.equal(c.sitemap.declaredTotal, 3);
    assert.ok(c.sitemapFound);
    const urls = c.pages.map((p) => canonicalUrl(p.url));
    assert.equal(new Set(urls).size, urls.length, 'fără duplicate');
    assert.ok(!urls.some((u) => /cart/.test(u)), 'coșul nu se crawl-uiește');
    assert.equal(c.pages.length, 3);
    const bot = (t: string) => c.bots.find((b) => b.token === t)!;
    assert.equal(bot('OAI-SearchBot').liveBlocked, false, '„recaptcha” în pagină nu înseamnă blocaj');
    assert.equal(bot('PerplexityBot').liveBlocked, true, 'pagina de challenge e detectată');
  } finally {
    srv.close();
  }
  assert.equal(canonicalUrl('https://x.ro/a/?ref=footer_3&utm_source=g&id=5'), 'https://x.ro/a?id=5');
});

test('profilare site: date din HTML + sinteză AI', async () => {
  const srv = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>MegaShop - Electronice online</title><meta name="description" content="Magazin online de electronice și electrocasnice.">
      <script type="application/ld+json">{"@type":"Organization","name":"MegaShop","telephone":"0212 000 000","sameAs":["https://facebook.com/megashop"]}</script></head>
      <body><nav><a href="/laptopuri">Laptopuri</a><a href="/telefoane">Telefoane</a><a href="/contact">Contact</a></nav><p>Adaugă în coș. Livrare gratuită peste 200 lei.</p></body></html>`);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const host = `127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const restore = mockLLM(() => claudeText(JSON.stringify({ brandName: 'MegaShop', aliases: ['Mega Shop'], description: 'Magazin online de electronice.', vertical: 'ecommerce', scope: 'national', country: 'RO', city: null, category: 'magazin online de electronice', categoryEn: 'electronics store', topics: [{ name: 'Laptopuri', description: 'x' }, { name: 'Telefoane' }], personas: [{ name: 'Student', description: 'Sunt student și caut un laptop ieftin.' }], usps: ['Livrare gratuită peste 200 lei'], competitors: [{ name: 'Altex', domain: 'https://www.altex.ro', reason: 'electronice' }, { name: 'MegaShop', domain: null }], facts: { phone: null, address: null } })));
  try {
    const noAI = await profileSite(`http://${host}`, configFromEnv({}));
    assert.equal(noAI.source, 'rules');
    assert.equal(noAI.brandName, 'MegaShop');
    assert.equal(noAI.vertical, 'ecommerce');
    assert.ok(noAI.topics.some((t) => t.name === 'Laptopuri'));
    assert.equal(noAI.facts.phone, '0212 000 000');
    const prof = await profileSite(`http://${host}`, configFromEnv({ ANTHROPIC_API_KEY: 'k' }));
    assert.equal(prof.source, 'ai');
    assert.equal(prof.category, 'magazin online de electronice');
    assert.equal(prof.competitors.length, 1, 'brandul propriu e scos din competitori');
    assert.equal(prof.competitors[0].domain, 'altex.ro');
    assert.equal(prof.facts.phone, '0212 000 000', 'faptele din HTML nu sunt suprascrise cu null');
  } finally {
    restore();
    srv.close();
  }
});

test('loguri: IIS, combined și JSON; boți, blocaje, referreri AI', async () => {
  const a = new LogAnalyzer();
  [
    '#Fields: date time s-ip cs-method cs-uri-stem cs-uri-query s-port cs-username c-ip cs(User-Agent) cs(Referer) sc-status',
    '2026-11-20 10:00:00 10.0.0.1 GET /laptopuri - 443 - 1.2.3.4 Mozilla/5.0+(compatible;+OAI-SearchBot/1.4;++https://openai.com/searchbot) - 200',
    '2026-11-20 10:00:01 10.0.0.1 GET /telefoane - 443 - 1.2.3.4 Mozilla/5.0+AppleWebKit/537.36+(KHTML,+like+Gecko;+compatible;+Claude-SearchBot/1.0) - 403',
    '2026-11-21 11:00:00 10.0.0.1 GET /laptopuri - 443 - 5.6.7.8 Mozilla/5.0+(Windows) https://chatgpt.com/ 200',
  ].forEach((l) => a.push(l));
  const r = a.report(['/laptopuri', '/despre']);
  assert.equal(r.format, 'IIS W3C');
  assert.equal(r.bots.find((b) => b.token === 'OAI-SearchBot')!.hits, 1);
  assert.equal(r.bots.find((b) => b.token === 'Claude-SearchBot')!.blocked, 1);
  assert.equal(r.aiReferrals[0].source, 'chatgpt.com');
  assert.deepEqual(r.notCrawled, ['/despre']);
  const b = new LogAnalyzer();
  b.push('1.1.1.1 - - [20/Nov/2026:10:00:00 +0000] "GET /x HTTP/1.1" 200 512 "-" "Mozilla/5.0 (compatible; PerplexityBot/1.0)"');
  b.push('{"EdgeStartTimestamp":"2026-11-20T10:00:00Z","ClientRequestPath":"/y","EdgeResponseStatus":200,"ClientRequestUserAgent":"GPTBot/1.3","ClientRequestReferer":""}');
  const rb = b.report();
  assert.equal(rb.parsed, 2);
  assert.ok(rb.bots.some((x) => x.token === 'PerplexityBot') && rb.bots.some((x) => x.token === 'GPTBot'));
});

test('optimizator: semnale deterministe ale paginii', () => {
  const s = pageSignals('https://x.ro/laptop', 200, `<html><head><title>Laptop programare</title><script type="application/ld+json">{"@type":"Product"}</script></head><body><h1>Cel mai bun laptop pentru programare</h1><p>Cel mai bun laptop pentru programare are 16 GB RAM și costă de la 3.500 lei.</p><h2>Cât RAM trebuie?</h2><h2>Ce procesor?</h2><h2>Ce ecran?</h2></body></html>`, 'cel mai bun laptop pentru programare');
  assert.equal(s.answersEarly, true);
  assert.equal(s.questionHeadings, 3);
  assert.ok(s.checks.find((c) => c.label === 'Date structurate')!.ok);
});

test('chei invalide: diagnostic clar și oprirea rapidă a rulării', async () => {
  const restore = mockLLM((host) => (host.includes('anthropic') ? { status: 401, json: { type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } } } : { json: {} }));
  try {
    const t = await testEngines(configFromEnv({ ANTHROPIC_API_KEY: '  "sk-ant-oat01-abc"  ' }));
    assert.equal(t.claude.ok, false);
    assert.match(t.claude.hint ?? '', /OAuth/);
    assert.match(t.claude.key, /^sk-ant-/);
    const store = new Store(':memory:');
    const svc = new Service(store, { ANTHROPIC_API_KEY: 'sk-ant-api-bad' }, () => {});
    const p = svc.createProject({ ...shop, name: 'eMAG', domain: 'emag.ro', engines: ['claude'] });
    const runId = svc.startRun(p.id, { repetitions: 3 });
    const t0 = Date.now();
    await svc.processRun(store.claimJob(['run'])!);
    const run = store.getRun(runId)!;
    assert.equal(run.status, 'failed');
    assert.match(run.error ?? '', /401/);
    assert.ok(Date.now() - t0 < 5000, 'nu trimite toate cererile după un 401');
    const st = svc.runStatus(p.id);
    assert.equal(st.failed, true);
  } finally {
    restore();
  }
});

test('analitică pe demo: AI #1, topicuri, persone, fan-out, percepție, scor', () => {
  const store = new Store(':memory:');
  const svc = new Service(store, {}, () => {});
  const p = svc.seedDemo();
  const a = computeAnalytics(store.listResults(p.id), store.listPrompts(p.id), p);
  assert.ok(a.validAnswers > 100);
  assert.ok(Object.keys(a.engineTop).length === 4);
  assert.ok(a.topics.filter((t) => t.n > 0).length >= 3, 'prompturile sunt grupate pe topicuri');
  assert.ok(a.personas.length >= 3);
  assert.ok(a.fanout.length > 3);
  assert.ok(a.brandTrend.length > 0 && a.trendBrands[0] === p.name);
  assert.ok(a.visibilityScore.score > 0 && a.visibilityScore.score <= 100);
  assert.ok(a.brands.find((b) => b.own)!.attributes.length > 0, 'atribute pentru brandul propriu');
  assert.ok(a.engineAverages.all!.brandsPerAnswer > 3);
  const d = svc.dashboard(p.id);
  assert.ok(d.sources.groupShare.brand_sites !== undefined || Object.keys(d.sources.groupShare).length > 2);
});

test('cheie pusă la furnizorul greșit: diagnostic explicit', async () => {
  const { keyHint } = await import('../src/core/llm.ts');
  assert.match(keyHint('anthropic', 'AQ.Ab8RN6Lfk-test')!, /GEMINI_API_KEY/);
  assert.equal(keyHint('gemini', 'AQ.Ab8RN6Lfk-test'), null);
  assert.equal(keyHint('gemini', 'AIzaSyTest'), null);
  assert.match(keyHint('openai', 'sk-ant-api03-x')!, /ANTHROPIC_API_KEY/);
});

test('model indisponibil: hint cu modelul sugerat de furnizor', async () => {
  const restore = mockLLM((host) => (host.includes('generativelanguage') ? { status: 404, json: { error: { message: 'This model models/gemini-2.5-flash is no longer available to new users. Please update your code to use models/gemini-3.8-flash for the latest features and improvements.' } } } : { json: {} }));
  try {
    const t = await testEngines(configFromEnv({ GEMINI_API_KEY: 'AQ.Ab8-test', GEMINI_MODEL: 'gemini-2.5-flash' }));
    assert.equal(t.gemini.ok, false);
    assert.match(t.gemini.hint ?? '', /GEMINI_MODEL=gemini-3\.8-flash/);
  } finally {
    restore();
  }
});

test('model suprasolicitat (503): fără hint fals de „model inexistent”, cu modelele disponibile și rezervă automată', async () => {
  const orig = globalThis.fetch;
  const calls: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    calls.push(u);
    if (u.includes('/v1beta/models?')) return new Response(JSON.stringify({ models: [
      { name: 'models/gemini-3.8-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.5-flash', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/gemini-3.8-pro', supportedGenerationMethods: ['generateContent'] },
      { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
    ] }), { status: 200 });
    if (u.includes('gemini-3.5-flash:generateContent')) return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'Altex' }] } }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.' } }), { status: 503 });
  }) as typeof fetch;
  try {
    const t = await testEngines(configFromEnv({ GEMINI_API_KEY: 'AQ.x', GEMINI_MODEL: 'gemini-3.8-flash' }));
    // rezerva automată funcționează → motorul e raportat ca funcțional, pe modelul de rezervă
    assert.equal(t.gemini.ok, true);
    assert.match(t.gemini.model, /gemini-3\.8-flash → gemini-3\.5-flash/);
    assert.match(t.gemini.hint ?? '', /suprasolicitat/);
    // un placeholder lăsat în .env e ignorat, se alege automat un model valid
    const r0 = await (await import('../src/core/engines.ts')).runEngine('gemini', { prompt: 'x', lang: 'ro', country: 'RO', local: false }, configFromEnv({ GEMINI_API_KEY: 'AQ.x', GEMINI_MODEL: 'gemini-3.8-flash', GEMINI_FALLBACK_MODEL: '<un model flash din lista afișată>' }));
    assert.equal(r0.error, undefined);
    assert.equal(r0.model, 'gemini-3.5-flash');
    const { runEngine } = await import('../src/core/engines.ts');
    const r = await runEngine('gemini', { prompt: 'x', lang: 'ro', country: 'RO', local: false }, configFromEnv({ GEMINI_API_KEY: 'AQ.x', GEMINI_MODEL: 'gemini-3.8-flash', GEMINI_FALLBACK_MODEL: 'gemini-3.5-flash' }));
    assert.equal(r.error, undefined);
    assert.equal(r.text, 'Altex');
  } finally {
    globalThis.fetch = orig;
  }
});

test('rezerva Gemini preferă modelele stabile față de „preview” și încearcă mai multe', async () => {
  const orig = globalThis.fetch;
  const gen: string[] = [];
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.includes('/v1beta/models?')) return new Response(JSON.stringify({ models: [
      'gemini-3.8-flash', 'gemini-omni-flash-preview', 'gemini-omni-1.2-flash', 'gemini-omni-1.1-flash', 'gemini-flash-latest', 'gemini-3.7-flash', 'gemini-3.6-flash',
    ].map((n) => ({ name: `models/${n}`, supportedGenerationMethods: ['generateContent'] })) }), { status: 200 });
    const m = u.match(/models\/([^:]+):generateContent/)?.[1];
    if (m) gen.push(decodeURIComponent(m));
    if (m === 'gemini-3.6-flash') return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: 'OK' }] } }] }), { status: 200 });
    return new Response(JSON.stringify({ error: { message: 'This model is currently experiencing high demand.' } }), { status: 503 });
  }) as typeof fetch;
  try {
    const t = await testEngines(configFromEnv({ GEMINI_API_KEY: 'AQ.stable', GEMINI_MODEL: 'gemini-3.8-flash', GEMINI_FALLBACK_MODEL: 'auto' }));
    assert.equal(t.gemini.ok, true);
    assert.match(t.gemini.model, /→ gemini-3\.6-flash/);
    assert.ok(!gen.includes('gemini-omni-flash-preview'), 'preview nu trebuie încercat înaintea celor stabile');
    assert.ok(gen.indexOf('gemini-3.7-flash') < gen.indexOf('gemini-3.6-flash'));
  } finally {
    globalThis.fetch = orig;
  }
});

test('rularea folosește motoarele cu cheie când cele bifate nu au (proiect vechi cu doar Claude)', () => {
  const store = new Store(':memory:');
  const svc = new Service(store, { GEMINI_API_KEY: 'AQ.x' }, () => {});
  const p = svc.createProject({ ...shop, name: 'eMAG', domain: 'emag.ro', engines: ['claude'] });
  svc.startRun(p.id, { repetitions: 1 });
  const job = store.claimJob(['run'])!;
  assert.deepEqual(job.payload.engines, ['gemini']);
  assert.deepEqual(store.getProject(p.id)!.engines, ['gemini'], 'proiectul e actualizat ca să nu mai eșueze');
  const none = new Service(new Store(':memory:'), {}, () => {});
  const q = none.createProject({ ...shop, engines: ['claude'] });
  assert.throws(() => none.startRun(q.id), /Niciun motor AI cu cheie/);
});

test('WAF care respinge și Googlebot fals: testul de boți e neconcludent, nu „blocat”', async () => {
  const big = `<html><head><title>Magazin</title></head><body>${'<p>produs</p>'.repeat(800)}</body></html>`;
  const challenge = '<html><head><title>Access Denied</title></head><body>Reference #18</body></html>';
  const srv = createServer((req, res) => {
    const ua = String(req.headers['user-agent'] ?? '');
    const bot = /bot|-user|duckassist|applebot/i.test(ua);
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(bot && req.url === '/' ? challenge : big);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = (srv.address() as AddressInfo).port;
    const crawl = await crawlSite(`http://127.0.0.1:${port}`, { maxPages: 2 });
    const g = crawl.bots.find((b) => b.token === 'Googlebot')!;
    assert.equal(g.liveBlocked, true);
    assert.match(g.liveReason ?? '', /Access Denied/);
    const { runAudit } = await import('../src/core/audit.ts');
    const a = runAudit({ project: { ...shop, domain: `127.0.0.1:${port}` }, crawl, manualDone: new Set() });
    const w = a.findings.find((f) => f.id === 'waf_bots')!;
    assert.equal(w.status, 'warn');
    assert.match(w.detail, /Neconcludent/);
    assert.ok(a.version && a.version >= 3);
  } finally {
    srv.close();
  }
});

test('audit blocat (511): nu înlocuiește auditul bun și nu pică fals verificările de conținut', async () => {
  let block = false;
  const page = `<html><head><title>Magazin online electronice</title><meta name="description" content="Laptopuri"></head><body><h1>Magazin</h1>${'<p>Laptop 3.499 lei, livrare 24h.</p>'.repeat(50)}</body></html>`;
  const srv = createServer((req, res) => {
    if (block) { res.writeHead(511, { 'content-type': 'text/html' }); return res.end('Network Authentication Required'); }
    if (req.url === '/robots.txt') { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(page);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const port = (srv.address() as AddressInfo).port;
    const store = new Store(':memory:');
    const svc = new Service(store, {}, () => {});
    const p0 = svc.createProject({ ...shop, engines: [] });
    const p = { ...p0, domain: `http://127.0.0.1:${port}` };
    store.saveProject(p);
    const job = () => ({ id: 'j', type: 'audit' as const, projectId: p.id, payload: { maxPages: 2 }, status: 'running' as const, attempts: 0, error: null, createdAt: new Date().toISOString() });
    await svc.processAudit(job());
    const good = svc.dashboard(p.id).audit!;
    assert.ok(!good.unreadable && good.score > 20);
    block = true;
    await svc.processAudit(job());
    const raw = store.latestAudit(p.id)!;
    assert.equal(raw.unreadable?.status, 511);
    assert.equal(raw.findings.find((f) => f.id === 'h1')?.status ?? 'na', 'na', 'verificările de conținut nu sunt picate fals');
    svc['cache'].clear();
    const d = svc.dashboard(p.id);
    assert.equal(d.audit!.score, good.score, 'se afișează în continuare auditul bun');
    assert.match(d.auditBlocked!.reason, /511/);
    assert.equal(store.auditHistory(p.id).length, 1);
  } finally {
    srv.close();
  }
});

test('Gemini 429: tipul cotei și timpul de așteptare sunt extrase din răspuns', async () => {
  const { geminiError, isDailyQuota, retryAfterSeconds } = await import('../src/core/llm.ts');
  const day = geminiError({ status: 429, text: '', json: { error: { message: 'You exceeded your current quota, please check your plan and billing details. For more information on this error, head to: https://x', details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier' }] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '34s' }] } } }, 'gemini-3.6-flash');
  assert.match(day, /cotă zilnică epuizată/);
  assert.doesNotMatch(day, /For more information/);
  assert.ok(isDailyQuota(day));
  const min = geminiError({ status: 429, text: '', json: { error: { message: 'quota', details: [{ violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier' }] }, { retryDelay: '21.5s' }] } } });
  assert.ok(!isDailyQuota(min));
  assert.equal(retryAfterSeconds(min), 22);
});
