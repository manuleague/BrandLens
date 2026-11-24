import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { runAudit } from '../src/core/audit.ts';
import { crawlSite } from '../src/core/crawler.ts';
import { configFromEnv, runEngine } from '../src/core/engines.ts';
import { discoverEntities, extract } from '../src/core/extract.ts';
import { generate } from '../src/core/generators.ts';
import { parseHtml } from '../src/core/html.ts';
import { generatePrompts } from '../src/core/prompts.ts';
import { isAllowed, parseRobots } from '../src/core/robots.ts';
import type { Project } from '../src/core/types.ts';
import { wilson } from '../src/core/util.ts';
import { Store } from '../src/server/db.ts';
import { renderReport } from '../src/server/report.ts';
import { Service } from '../src/server/service.ts';

const project: Project = {
  id: 'p1', name: 'Pizzeria Luna', domain: 'pizzerialuna.ro', aliases: ['Luna Pizza'], vertical: 'restaurant', country: 'RO', city: 'Iași',
  neighborhoods: ['Copou'], services: ['pizza napoletană', 'pizza vegană'], languages: ['ro'], engines: ['chatgpt'], repetitions: 3, schedule: 'manual',
  competitors: [{ name: 'Pizzeria Sole', domain: 'sole.ro' }, { name: 'Napoli Express' }],
  facts: { address: 'Str. Lascăr Catargi 10', phone: '0740 111 222', hours: 'Mo-Su 11:00-23:00' }, shareToken: 't', createdAt: new Date().toISOString(),
};

test('robots.txt: grup specific, wildcard, linia regulii', () => {
  const r = parseRobots(`User-agent: *\nDisallow: /admin\n\nUser-agent: PerplexityBot\nUser-agent: GPTBot\nDisallow: /\n\nUser-agent: OAI-SearchBot\nAllow: /\nDisallow: /*.pdf$\nSitemap: https://x.ro/sitemap.xml`);
  assert.equal(isAllowed(r, 'PerplexityBot', '/').allowed, false);
  assert.equal(isAllowed(r, 'PerplexityBot', '/').rule?.line, 6);
  assert.equal(isAllowed(r, 'GPTBot', '/meniu').allowed, false);
  assert.equal(isAllowed(r, 'OAI-SearchBot', '/meniu').allowed, true);
  assert.equal(isAllowed(r, 'OAI-SearchBot', '/meniu.pdf').allowed, false);
  assert.equal(isAllowed(r, 'Bingbot', '/admin/x').allowed, false);
  assert.equal(isAllowed(r, 'Bingbot', '/').allowed, true);
  assert.deepEqual(r.sitemaps, ['https://x.ro/sitemap.xml']);
});

test('parseHtml: title, H1, JSON-LD, întrebări, text fără scripturi', () => {
  const p = parseHtml(`<html lang="ro"><head><title>Pizza în Iași | Luna</title><meta name="description" content="Pizza napoletană">
  <script type="application/ld+json">{"@context":"https://schema.org","@type":"Restaurant","name":"Luna","telephone":"0740111222"}</script></head>
  <body><h1>Pizzeria Luna</h1><h2>Aveți livrare în Copou?</h2><p>Da, livrăm în 30 de minute.</p><script>var x=1</script><a href="tel:0740111222">Sună</a></body></html>`);
  assert.equal(p.title, 'Pizza în Iași | Luna');
  assert.deepEqual(p.h1, ['Pizzeria Luna']);
  assert.ok(p.schemaTypes.includes('Restaurant'));
  assert.equal(p.questionHeadings.length, 1);
  assert.ok(!p.text.includes('var x'));
  assert.deepEqual(p.telLinks, ['0740111222']);
});

test('extract: mențiuni, poziție, recomandare, citare proprie, descoperiri, acuratețe', () => {
  const text = `Iată cele mai bune pizzerii din Iași:\n\n1. **Pizzeria Sole** – foarte apreciată, aluat bun.\n2. **Casa Mia** – populară printre studenți.\n3. **Pizzeria Luna** – cuptor pe lemne, recomand pizza napoletană. Telefon: 0232 999 888.\n\nNapoli Express este o opțiune pentru livrare.`;
  const ex = extract(text, [{ url: 'https://pizzerialuna.ro/meniu', domain: 'pizzerialuna.ro', kind: 'cited' }], project);
  assert.equal(ex.ownMentioned, true);
  assert.equal(ex.ownPosition, 3);
  assert.equal(ex.ownRecommended, true);
  assert.equal(ex.ownCited, true);
  assert.ok(ex.discovered.includes('Casa Mia'));
  assert.equal(ex.mentions.length, 3);
  assert.equal(ex.accuracy[0]?.field, 'phone');
  const none = extract('Nu cunosc o pizzerie cu acest nume.', [], project);
  assert.equal(none.ownMentioned, false);
  assert.deepEqual(discoverEntities('- **Trattoria X**: bună\n- Preț: 30 lei'), ['Trattoria X']);
});

test('diacritice: „Ș/ş” și majuscule nu rup potrivirea brandului', () => {
  const p = { ...project, name: 'Pizzeria Ștefan' };
  assert.equal(extract('Recomand pizzeria stefan din Copou.', [], p).ownMentioned, true);
  assert.equal(extract('Recomand PIZZERIA ŞTEFAN.', [], p).ownMentioned, true);
});

test('wilson: interval plauzibil', () => {
  const [a, b] = wilson(6, 20);
  assert.ok(a > 0.1 && a < 0.2 && b > 0.45 && b < 0.55);
});

test('prompturi: fără numele brandului în descoperire, echilibrate pe intenții', () => {
  const ps = generatePrompts(project, 20);
  assert.ok(ps.length >= 12);
  assert.ok(ps.filter((x) => x.intent !== 'brand').every((x) => !x.text.includes('Pizzeria Luna')));
  assert.ok(new Set(ps.map((x) => x.intent)).size >= 5);
  assert.ok(ps.every((x) => !/\{\w+\}/.test(x.text)));
});

test('adaptoare motoare: parsează răspunsurile oficiale (fetch simulat)', async () => {
  const orig = globalThis.fetch;
  const fixtures: Record<string, unknown> = {
    'api.openai.com': { model: 'gpt-x', output: [{ type: 'web_search_call', action: { query: 'pizza iasi', sources: [{ url: 'https://tripadvisor.com/a' }] } }, { type: 'message', content: [{ type: 'output_text', text: 'Pizzeria Luna e bună.', annotations: [{ type: 'url_citation', url: 'https://pizzerialuna.ro/?utm_source=openai', title: 'Luna' }] }] }], usage: { input_tokens: 100, output_tokens: 50 } },
    'api.anthropic.com': { model: 'claude-x', content: [{ type: 'server_tool_use', input: { query: 'pizza iasi' } }, { type: 'web_search_tool_result', content: [{ type: 'web_search_result', url: 'https://iasifun.ro/top', title: 'Top' }] }, { type: 'text', text: 'Pizzeria Sole', citations: [{ type: 'web_search_result_location', url: 'https://iasifun.ro/top', title: 'Top' }] }], usage: { input_tokens: 10, output_tokens: 5, server_tool_use: { web_search_requests: 1 } } },
    'generativelanguage.googleapis.com': { modelVersion: 'gemini-x', candidates: [{ content: { parts: [{ text: 'Napoli Express' }] }, groundingMetadata: { webSearchQueries: ['pizza'], groundingChunks: [{ web: { uri: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc', title: 'tripadvisor.com' } }, { maps: { uri: 'https://maps.google.com/?cid=1', title: 'Pizzeria Luna', placeId: 'x' } }] } }], usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 5 } },
    'api.perplexity.ai': { model: 'sonar', choices: [{ message: { content: 'Pizzeria Luna [1]' } }], search_results: [{ url: 'https://reddit.com/r/iasi/x', title: 'r/iasi' }], usage: { prompt_tokens: 5, completion_tokens: 5, cost: { total_cost: 0.006 } } },
  };
  globalThis.fetch = (async (url: string | URL) => {
    const host = new URL(String(url)).hostname;
    return new Response(JSON.stringify(fixtures[host]), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  try {
    const cfg = configFromEnv({ OPENAI_API_KEY: 'k', ANTHROPIC_API_KEY: 'k', GEMINI_API_KEY: 'k', PERPLEXITY_API_KEY: 'k' });
    const req = { prompt: 'pizza Iași', lang: 'ro' as const, country: 'RO', city: 'Iași', local: true };
    const o = await runEngine('chatgpt', req, cfg);
    assert.equal(o.error, undefined);
    assert.equal(o.citations.find((c) => c.kind === 'cited')?.url, 'https://pizzerialuna.ro/');
    assert.equal(o.citations.length, 2);
    const c = await runEngine('claude', req, cfg);
    assert.equal(c.citations[0].kind, 'cited');
    assert.deepEqual(c.searchQueries, ['pizza iasi']);
    const g = await runEngine('gemini', req, { ...cfg, geminiMaps: true });
    assert.equal(g.citations[0].domain, 'tripadvisor.com');
    assert.equal(g.citations[1].domain, 'maps.google.com');
    const px = await runEngine('perplexity', req, cfg);
    assert.equal(px.citations[0].domain, 'reddit.com');
    assert.equal(px.usage.costUsd, 0.006);
    const missing = await runEngine('chatgpt', req, configFromEnv({}));
    assert.match(missing.error ?? '', /OPENAI_API_KEY/);
  } finally {
    globalThis.fetch = orig;
  }
});

test('crawl + audit pe un site local de test', async () => {
  const pages: Record<string, string> = {
    '/': `<html lang="ro"><head><title>Pizzeria Luna</title></head><body><h1>Pizzeria Luna</h1><p>Cea mai bună pizza. Sunați la 0740 111 222.</p>
      <a href="/meniu">Meniu</a> <a href="/contact">Contact</a> <a href="/meniu.pdf">Meniu PDF</a> <a href="https://facebook.com/luna">Facebook</a></body></html>`,
    '/meniu': `<html><head><title>Meniu</title></head><body><div id="root"></div><script src="a.js"></script><script src="b.js"></script><script src="c.js"></script></body></html>`,
    '/contact': `<html><head><title>Contact</title><meta name="robots" content="noindex"></head><body><h1>Contact</h1><p>Str. Lascăr Catargi 10, Iași</p></body></html>`,
    '/robots.txt': `User-agent: PerplexityBot\nDisallow: /\n\nUser-agent: *\nAllow: /`,
  };
  const srv = createServer((req, res) => {
    const ua = String(req.headers['user-agent']);
    if (/Claude-SearchBot/.test(ua)) {
      res.writeHead(403);
      return res.end('Access denied');
    }
    const body = pages[req.url ?? '/'];
    if (!body) {
      res.writeHead(404);
      return res.end('nf');
    }
    res.writeHead(200, { 'content-type': req.url?.endsWith('.txt') ? 'text/plain' : 'text/html' });
    res.end(body);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  try {
    const crawl = await crawlSite(`http://127.0.0.1:${port}`, { maxPages: 10 });
    assert.equal(crawl.pages.length, 3);
    const audit = runAudit({ project: { ...project, domain: `127.0.0.1:${port}` }, crawl, manualDone: new Set(['gbp_complete']) });
    const st = (id: string) => audit.findings.find((f) => f.id === id)?.status;
    assert.equal(st('robots_ai_search'), 'fail');
    assert.equal(st('waf_bots'), 'fail');
    assert.equal(st('sitemap'), 'fail');
    assert.equal(st('server_rendered'), 'warn');
    assert.equal(st('indexable'), 'warn');
    assert.equal(st('schema_business'), 'fail');
    assert.equal(st('menu_prices_text'), 'fail');
    assert.equal(st('gbp_complete'), 'pass');
    assert.equal(st('nap_consistent'), 'pass');
    assert.ok(audit.score > 0 && audit.score < 50, `scor ${audit.score}`);
  } finally {
    srv.close();
  }
});

test('serviciu end-to-end: demo, metrici, acțiuni, generatoare, raport', async () => {
  const store = new Store(':memory:');
  const svc = new Service(store, {}, () => {});
  const p = svc.seedDemo();
  const d = svc.dashboard(p.id);
  assert.ok(d.metrics.overall.n > 100);
  assert.ok(d.metrics.trend.filter((t) => t.engine === 'all').length === 4);
  const first = d.metrics.trend.find((t) => t.engine === 'all')!.visibility;
  const last = d.metrics.trend.filter((t) => t.engine === 'all').at(-1)!.visibility;
  assert.ok(last > first, `trend ${first} → ${last}`);
  assert.ok(d.sources.rows.length > 3);
  assert.ok(d.audit && d.audit.score > 0);
  const a = svc.actions(p.id);
  assert.ok(a.items.length >= 10);
  assert.ok(a.items.some((i) => i.priority === 'P0'));
  assert.ok(a.items.some((i) => i.key.startsWith('source:')));
  assert.equal(a.progress.done, 3);
  // Bifarea unei verificări manuale crește scorul.
  const before = svc.dashboard(p.id).audit!.score;
  svc.setAction(p.id, 'check:reviews', { status: 'done' });
  assert.ok(svc.dashboard(p.id).audit!.score > before);
  for (const k of ['schema', 'robots', 'faq', 'brief', 'outreach', 'ga4', 'nap', 'reviews', 'llms'] as const) {
    const g = svc.generate(p.id, k, k === 'outreach' ? 'tripadvisor.com' : undefined);
    assert.ok(g.content.length > 100, k);
  }
  const schema = generate('schema', p, { prompts: [] });
  assert.match(schema.content, /OpeningHoursSpecification/);
  JSON.parse(schema.content.replace(/<\/?script[^>]*>/g, ''));
  // Rulare nouă pe demo prin worker (simulator).
  const runId = svc.startRun(p.id, { repetitions: 1 });
  const job = store.claimJob()!;
  await svc.processRun(job);
  assert.equal(store.getRun(runId)!.status, 'done');
  const html = renderReport(svc, p.id);
  assert.match(html, /Raport vizibilitate AI/);
  assert.match(html, /Metodologie/);
});
