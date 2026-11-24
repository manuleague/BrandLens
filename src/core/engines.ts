// Adaptoare pentru motoarele AI, prin API-urile oficiale cu căutare web activă.
// Interfață comună: execute(prompt, context local) → text + citări + interogări + cost.
// Nu automatizăm interfețele de consum (risc de încălcare a termenilor); calibrați periodic manual.

import type { Citation, EngineId, EngineRequest, EngineResult } from './types.ts';
import { geminiError, geminiFallbacks, keyHint, tryGeminiFallbacks, listGeminiModels, llmText, maskKey, type Provider } from './llm.ts';
export { listGeminiModels };
import { domainOf } from './util.ts';

export interface EngineConfig {
  openaiKey?: string;
  openaiModel: string;
  anthropicKey?: string;
  anthropicModel: string;
  geminiKey?: string;
  geminiModel: string;
  geminiMaps: boolean;
  geminiFallbackModel?: string;
  perplexityKey?: string;
  perplexityModel: string;
  timeoutMs: number;
  analysisEnabled?: boolean;
  analysisProvider?: string;
  analysisModel?: string;
  brokenProviders?: Set<string>; // furnizori cu cheie respinsă (401/403) — ocoliți la analiză
}

const clean = (v?: string) => {
  const t = (v ?? '').trim().replace(/^["']|["']$/g, '').trim();
  return t || undefined;
};

export function configFromEnv(env: Record<string, string | undefined> = process.env): EngineConfig {
  return {
    openaiKey: clean(env.OPENAI_API_KEY),
    openaiModel: env.OPENAI_MODEL || 'gpt-5-mini',
    anthropicKey: clean(env.ANTHROPIC_API_KEY),
    anthropicModel: env.ANTHROPIC_MODEL || 'claude-sonnet-5-5',
    geminiKey: clean(env.GEMINI_API_KEY || env.GOOGLE_API_KEY),
    geminiModel: env.GEMINI_MODEL || 'gemini-3.8-flash',
    geminiMaps: env.GEMINI_MAPS === '1',
    geminiFallbackModel: env.GEMINI_FALLBACK_MODEL || undefined,
    perplexityKey: clean(env.PERPLEXITY_API_KEY),
    perplexityModel: env.PERPLEXITY_MODEL || 'sonar',
    timeoutMs: Number(env.ENGINE_TIMEOUT_MS || 90000),
    analysisEnabled: env.ANALYSIS !== '0',
    analysisProvider: env.ANALYSIS_PROVIDER || undefined,
    analysisModel: env.ANALYSIS_MODEL || undefined,
    brokenProviders: new Set(),
  };
}

export const ENGINE_LABEL: Record<EngineId, string> = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  perplexity: 'Perplexity',
  simulator: 'Simulator (demo)',
};

/** Cost estimativ per apel (USD) — doar pentru bugetare; actualizați după listele de prețuri curente. */
const PRICE = {
  chatgpt: { in: 0.25, out: 2.0, search: 0.01 },
  claude: { in: 3.0, out: 15.0, search: 0.01 },
  gemini: { in: 0.3, out: 2.5, search: 0.035 },
  perplexity: { in: 1.0, out: 1.0, search: 0.008 },
};

export function engineStatus(cfg: EngineConfig): Record<EngineId, { configured: boolean; model: string }> {
  return {
    chatgpt: { configured: !!cfg.openaiKey, model: cfg.openaiModel },
    claude: { configured: !!cfg.anthropicKey, model: cfg.anthropicModel },
    gemini: { configured: !!cfg.geminiKey, model: cfg.geminiModel },
    perplexity: { configured: !!cfg.perplexityKey, model: cfg.perplexityModel },
    simulator: { configured: true, model: 'sim-1' },
  };
}

async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json: any; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* răspuns non-JSON */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

function dedupe(cits: Citation[]): Citation[] {
  const m = new Map<string, Citation>();
  for (const c of cits) {
    const prev = m.get(c.url);
    if (!prev || (prev.kind === 'retrieved' && c.kind === 'cited')) m.set(c.url, c);
  }
  return [...m.values()];
}

const cleanUrl = (u: string) => u.replace(/[?&]utm_source=openai$/, '').replace(/\?utm_source=openai&/, '?');

// ── OpenAI (Responses API + web_search)
async function runOpenAI(req: EngineRequest, cfg: EngineConfig): Promise<Omit<EngineResult, 'latencyMs'>> {
  const body: any = {
    model: cfg.openaiModel,
    input: req.prompt,
    tools: [{ type: 'web_search', user_location: { type: 'approximate', country: req.country, ...(req.city ? { city: req.city } : {}), ...(req.region ? { region: req.region } : {}) } }],
    include: ['web_search_call.action.sources'],
    store: false,
  };
  const r = await postJson('https://api.openai.com/v1/responses', { authorization: `Bearer ${cfg.openaiKey}` }, body, cfg.timeoutMs);
  if (r.status >= 400) throw new Error(`OpenAI ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 300)}`);
  const out: any[] = r.json?.output ?? [];
  let text = '';
  const cits: Citation[] = [];
  const queries: string[] = [];
  let searches = 0;
  for (const item of out) {
    if (item.type === 'web_search_call') {
      searches++;
      if (item.action?.query) queries.push(item.action.query);
      for (const s of item.action?.sources ?? []) if (s.url) cits.push({ url: cleanUrl(s.url), title: s.title, domain: domainOf(s.url), kind: 'retrieved' });
    }
    if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text') {
          text += c.text;
          for (const a of c.annotations ?? []) if (a.type === 'url_citation' && a.url) cits.push({ url: cleanUrl(a.url), title: a.title, domain: domainOf(a.url), kind: 'cited' });
        }
      }
    }
  }
  const u = r.json?.usage ?? {};
  const cost = ((u.input_tokens ?? 0) * PRICE.chatgpt.in + (u.output_tokens ?? 0) * PRICE.chatgpt.out) / 1e6 + searches * PRICE.chatgpt.search;
  return { engine: 'chatgpt', model: r.json?.model ?? cfg.openaiModel, text, citations: dedupe(cits), searchQueries: queries, usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, searches, costUsd: cost } };
}

// ── Anthropic (Messages API + web_search tool)
async function runClaude(req: EngineRequest, cfg: EngineConfig): Promise<Omit<EngineResult, 'latencyMs'>> {
  const body: any = {
    model: cfg.anthropicModel,
    max_tokens: 2048,
    messages: [{ role: 'user', content: req.prompt }],
    tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5, user_location: { type: 'approximate', country: req.country, ...(req.city ? { city: req.city } : {}), ...(req.region ? { region: req.region } : {}) } }],
  };
  const r = await postJson('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.anthropicKey!, 'anthropic-version': '2023-06-01' }, body, cfg.timeoutMs);
  if (r.status >= 400) throw new Error(`Anthropic ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 300)}`);
  let text = '';
  const cits: Citation[] = [];
  const queries: string[] = [];
  for (const b of r.json?.content ?? []) {
    if (b.type === 'text') {
      text += b.text;
      for (const c of b.citations ?? []) if (c.url) cits.push({ url: c.url, title: c.title, domain: domainOf(c.url), kind: 'cited' });
    } else if (b.type === 'server_tool_use' && b.input?.query) {
      queries.push(b.input.query);
    } else if (b.type === 'web_search_tool_result' && Array.isArray(b.content)) {
      for (const s of b.content) if (s.url) cits.push({ url: s.url, title: s.title, domain: domainOf(s.url), kind: 'retrieved' });
    }
  }
  const u = r.json?.usage ?? {};
  const searches = u.server_tool_use?.web_search_requests ?? queries.length;
  const cost = ((u.input_tokens ?? 0) * PRICE.claude.in + (u.output_tokens ?? 0) * PRICE.claude.out) / 1e6 + searches * PRICE.claude.search;
  return { engine: 'claude', model: r.json?.model ?? cfg.anthropicModel, text, citations: dedupe(cits), searchQueries: queries, usage: { inputTokens: u.input_tokens, outputTokens: u.output_tokens, searches, costUsd: cost } };
}

// ── Gemini (generateContent + google_search, opțional google_maps pentru business local)
async function runGemini(req: EngineRequest, cfg: EngineConfig): Promise<Omit<EngineResult, 'latencyMs'>> {
  const tools: any[] = [{ google_search: {} }];
  const body: any = { contents: [{ role: 'user', parts: [{ text: req.prompt }] }], tools };
  if (cfg.geminiMaps && req.local) {
    tools.push({ googleMaps: {} });
    if (req.lat !== undefined && req.lng !== undefined) body.toolConfig = { retrievalConfig: { latLng: { latitude: req.lat, longitude: req.lng } } };
  }
  const call = (model: string) => postJson(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, { 'x-goog-api-key': cfg.geminiKey! }, body, cfg.timeoutMs);
  let r = await call(cfg.geminiModel);
  // Model suprasolicitat (503/429/529) → modelul de rezervă din GEMINI_FALLBACK_MODEL, dacă e setat.
  let usedModel = cfg.geminiModel;
  if ([429, 503, 529].includes(r.status)) {
    // Se încearcă până la 3 modele de rezervă; dacă niciunul nu merge, păstrăm eroarea modelului principal.
    const fb = await tryGeminiFallbacks(cfg, cfg.geminiModel, call);
    if (fb.r && fb.model) {
      r = fb.r;
      usedModel = fb.model;
    }
  }
  if (r.status >= 400) throw new Error(geminiError(r, cfg.geminiModel));
  const cand = r.json?.candidates?.[0] ?? {};
  const text = (cand.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
  const gm = cand.groundingMetadata ?? {};
  const cits: Citation[] = [];
  for (const ch of gm.groundingChunks ?? []) {
    if (ch.web?.uri) {
      // Gemini întoarce URL-uri de redirect (vertexaisearch); titlul conține de regulă domeniul sursei.
      const title: string = ch.web.title ?? '';
      const dom = /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(title) ? title.toLowerCase().replace(/^www\./, '') : domainOf(ch.web.uri);
      cits.push({ url: ch.web.uri, title, domain: dom, kind: 'cited' });
    }
    if (ch.maps?.uri) cits.push({ url: ch.maps.uri, title: ch.maps.title, domain: 'maps.google.com', kind: 'cited' });
  }
  const u = r.json?.usageMetadata ?? {};
  const searches = (gm.webSearchQueries ?? []).length ? 1 : 0;
  const cost = ((u.promptTokenCount ?? 0) * PRICE.gemini.in + (u.candidatesTokenCount ?? 0) * PRICE.gemini.out) / 1e6 + searches * PRICE.gemini.search;
  return { engine: 'gemini', model: r.json?.modelVersion ?? usedModel, text, citations: dedupe(cits), searchQueries: gm.webSearchQueries ?? [], usage: { inputTokens: u.promptTokenCount, outputTokens: u.candidatesTokenCount, searches, costUsd: cost } };
}

// ── Perplexity (Sonar, compatibil chat completions)
async function runPerplexity(req: EngineRequest, cfg: EngineConfig): Promise<Omit<EngineResult, 'latencyMs'>> {
  const body: any = {
    model: cfg.perplexityModel,
    messages: [{ role: 'user', content: req.prompt }],
    web_search_options: { user_location: { country: req.country, ...(req.city ? { city: req.city } : {}), ...(req.region ? { region: req.region } : {}), ...(req.lat !== undefined ? { latitude: req.lat, longitude: req.lng } : {}) } },
  };
  const r = await postJson('https://api.perplexity.ai/chat/completions', { authorization: `Bearer ${cfg.perplexityKey}` }, body, cfg.timeoutMs);
  if (r.status >= 400) throw new Error(`Perplexity ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 300)}`);
  const text: string = r.json?.choices?.[0]?.message?.content ?? '';
  const cits: Citation[] = [];
  const sr: any[] = r.json?.search_results ?? [];
  if (sr.length) sr.forEach((s) => s.url && cits.push({ url: s.url, title: s.title, domain: domainOf(s.url), kind: 'cited' }));
  else (r.json?.citations ?? []).forEach((u: string) => cits.push({ url: u, domain: domainOf(u), kind: 'cited' }));
  const u = r.json?.usage ?? {};
  const cost = u.cost?.total_cost ?? ((u.prompt_tokens ?? 0) * PRICE.perplexity.in + (u.completion_tokens ?? 0) * PRICE.perplexity.out) / 1e6 + PRICE.perplexity.search;
  return { engine: 'perplexity', model: r.json?.model ?? cfg.perplexityModel, text, citations: dedupe(cits), searchQueries: [], usage: { inputTokens: u.prompt_tokens, outputTokens: u.completion_tokens, searches: 1, costUsd: cost } };
}

export type SimulatorFn = (req: EngineRequest, engine: EngineId) => Omit<EngineResult, 'latencyMs'>;
let simulator: SimulatorFn | null = null;
export function setSimulator(fn: SimulatorFn): void {
  simulator = fn;
}

export async function runEngine(engine: EngineId, req: EngineRequest, cfg: EngineConfig): Promise<EngineResult> {
  const t0 = Date.now();
  const base = { engine, model: '', text: '', citations: [], searchQueries: [], usage: {} };
  try {
    let r: Omit<EngineResult, 'latencyMs'>;
    if (engine === 'simulator') {
      if (!simulator) throw new Error('Simulatorul nu este înregistrat.');
      r = simulator(req, engine);
    } else if (engine === 'chatgpt') {
      if (!cfg.openaiKey) throw new Error('OPENAI_API_KEY lipsește.');
      r = await runOpenAI(req, cfg);
    } else if (engine === 'claude') {
      if (!cfg.anthropicKey) throw new Error('ANTHROPIC_API_KEY lipsește.');
      r = await runClaude(req, cfg);
    } else if (engine === 'gemini') {
      if (!cfg.geminiKey) throw new Error('GEMINI_API_KEY lipsește.');
      r = await runGemini(req, cfg);
    } else if (engine === 'perplexity') {
      if (!cfg.perplexityKey) throw new Error('PERPLEXITY_API_KEY lipsește.');
      r = await runPerplexity(req, cfg);
    } else throw new Error(`Motor necunoscut: ${engine}`);
    if (!r.text.trim()) return { ...r, latencyMs: Date.now() - t0, error: 'Răspuns gol' };
    return { ...r, latencyMs: Date.now() - t0 };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'Timeout' : (e as Error).message;
    return { ...base, latencyMs: Date.now() - t0, error: msg };
  }
}

/** Apel simplu de completare (fără căutare) — delegat stratului LLM de analiză. */
export async function complete(prompt: string, cfg: EngineConfig): Promise<string | null> {
  const r = await llmText(prompt, cfg);
  return r.error ? null : r.text || null;
}

/** Test de conexiune pentru fiecare motor configurat: un apel minim, cu diagnostic clar al cheii. */
export async function testEngines(cfg: EngineConfig): Promise<Record<string, { configured: boolean; ok: boolean; model: string; ms?: number; error?: string; hint?: string; key: string }>> {
  const providers: [EngineId, Provider, string | undefined, string][] = [
    ['chatgpt', 'openai', cfg.openaiKey, cfg.openaiModel],
    ['claude', 'anthropic', cfg.anthropicKey, cfg.anthropicModel],
    ['gemini', 'gemini', cfg.geminiKey, cfg.geminiModel],
    ['perplexity', 'perplexity', cfg.perplexityKey, cfg.perplexityModel],
  ];
  const out: Record<string, { configured: boolean; ok: boolean; model: string; ms?: number; error?: string; hint?: string; key: string }> = {};
  await Promise.all(
    providers.map(async ([engine, provider, key, model]) => {
      if (!key) {
        out[engine] = { configured: false, ok: false, model, key: maskKey(key) };
        return;
      }
      const t0 = Date.now();
      const r = await llmText('Reply with the single word: OK', cfg, { provider, model, maxTokens: 20, noFallback: true });
      // Furnizorii sugerează adesea modelul de înlocuire în mesajul de eroare („use models/gemini-…”).
      const suggested = r.error?.match(/use (?:models\/)?([a-z0-9][a-z0-9.\-]+)/i)?.[1]?.replace(/\.$/, '');
      const envName = { openai: 'OPENAI_MODEL', anthropic: 'ANTHROPIC_MODEL', gemini: 'GEMINI_MODEL', perplexity: 'PERPLEXITY_MODEL' }[provider];
      const overloaded = !!r.error && /\b(503|529)\b|high demand|overloaded|unavailable|try again later/i.test(r.error);
      const missing = !!r.error && !overloaded && /\b404\b|not found|no longer available|does not exist|not supported/i.test(r.error);
      const available = (overloaded || missing) && provider === 'gemini' ? await listGeminiModels(key) : [];
      const alt = available.filter((m) => m !== model).slice(0, 6);
      let fbNote = '';
      if (overloaded && provider === 'gemini') {
        const tried: string[] = [];
        for (const fb of await geminiFallbacks(cfg, model)) {
          const r2 = await llmText('Reply with the single word: OK', cfg, { provider, model: fb, maxTokens: 20, noFallback: true });
          if (!r2.error) {
            out[engine] = { configured: true, ok: true, model: `${model} → ${fb}`, ms: Date.now() - t0, error: undefined, hint: `${model} e suprasolicitat (503); se folosește automat ${fb}. Ca să scăpați de așteptare, puteți pune direct GEMINI_MODEL=${fb} în .env.`, key: maskKey(key) };
            return;
          }
          tried.push(`${fb} (${(r2.error.match(/Gemini (\d{3})/)?.[1]) ?? 'eroare'})`);
        }
        if (tried.length) fbNote = ` Au eșuat și rezervele: ${tried.join(', ')}.`;
      }
      const hint = overloaded
        ? `Modelul e suprasolicitat temporar la furnizor (nu e o problemă de configurare). Reîncercați peste câteva minute.${fbNote}${alt.length ? ` Modele disponibile pentru cheia dvs.: ${alt.join(', ')}.` : ''}`
        : missing
          ? `Modelul „${model}” nu e disponibil pentru cheia dvs. Puneți în .env: ${envName}=${suggested ?? alt[0] ?? '<model disponibil>'} și reporniți serverul.${alt.length ? ` Disponibile: ${alt.join(', ')}.` : ''}`
          : r.error && /401|403|invalid|unauthor|permission/i.test(r.error)
          ? keyHint(provider, key) ?? 'Cheia e respinsă: verificați că e copiată complet, că nu a fost revocată și că aparține contului cu credit.'
          : r.error ? keyHint(provider, key) ?? undefined : undefined;
      out[engine] = { configured: true, ok: !r.error, model, ms: Date.now() - t0, error: r.error, hint, key: maskKey(key) };
      if (r.error && /401|403/.test(r.error)) cfg.brokenProviders?.add(provider);
      else cfg.brokenProviders?.delete(provider);
    }),
  );
  return out;
}
