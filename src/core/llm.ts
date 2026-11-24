// Stratul LLM pentru analiză (nu pentru măsurare): profilare site, generare prompturi, analiza răspunsurilor,
// optimizare de conținut, recomandări. Folosește furnizorul ales în ANALYSIS_PROVIDER sau primul cu cheie validă.

import type { EngineConfig } from './engines.ts';

export type Provider = 'openai' | 'anthropic' | 'gemini' | 'perplexity';

export interface LlmResult {
  text: string;
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error?: string;
}

// USD / 1M tokeni (orientativ, pentru bugetare; modelele de analiză sunt de regulă cele ieftine).
const PRICE: Record<Provider, { in: number; out: number }> = {
  openai: { in: 0.25, out: 2 },
  anthropic: { in: 1, out: 5 },
  gemini: { in: 0.3, out: 2.5 },
  perplexity: { in: 1, out: 1 },
};

const DEFAULT_ANALYSIS_MODEL: Record<Provider, (cfg: EngineConfig) => string> = {
  openai: (c) => c.openaiModel,
  anthropic: (c) => c.anthropicModel,
  gemini: (c) => c.geminiModel,
  perplexity: (c) => c.perplexityModel,
};

const keyOf = (p: Provider, c: EngineConfig) => ({ openai: c.openaiKey, anthropic: c.anthropicKey, gemini: c.geminiKey, perplexity: c.perplexityKey })[p];

/** Furnizorul folosit pentru analiză sau null dacă nu există nicio cheie. */
export function analysisProvider(cfg: EngineConfig): { provider: Provider; model: string } | null {
  if (cfg.analysisEnabled === false) return null;
  const order: Provider[] = cfg.analysisProvider ? [cfg.analysisProvider as Provider] : ['openai', 'anthropic', 'gemini', 'perplexity'];
  for (const p of order) {
    if (keyOf(p, cfg) && !cfg.brokenProviders?.has(p)) return { provider: p, model: cfg.analysisModel || DEFAULT_ANALYSIS_MODEL[p](cfg) };
  }
  return null;
}

async function post(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number): Promise<{ status: number; json: any; text: string }> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body), signal: ctrl.signal });
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      /* non-JSON */
    }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

export async function llmText(prompt: string, cfg: EngineConfig, opts: { system?: string; maxTokens?: number; provider?: Provider; model?: string; noFallback?: boolean } = {}): Promise<LlmResult> {
  const ap = opts.provider ? { provider: opts.provider, model: opts.model || DEFAULT_ANALYSIS_MODEL[opts.provider](cfg) } : analysisProvider(cfg);
  if (!ap) return { text: '', provider: 'openai', model: '', inputTokens: 0, outputTokens: 0, costUsd: 0, error: 'Niciun furnizor LLM configurat pentru analiză.' };
  const { provider, model } = ap;
  const maxTokens = opts.maxTokens ?? 2500;
  const timeout = Math.max(cfg.timeoutMs, 60000);
  try {
    let text = '';
    let inT = 0;
    let outT = 0;
    if (provider === 'openai') {
      const r = await post('https://api.openai.com/v1/responses', { authorization: `Bearer ${cfg.openaiKey}` }, { model, input: prompt, instructions: opts.system, max_output_tokens: maxTokens, store: false }, timeout);
      if (r.status >= 400) throw new Error(`OpenAI ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 200)}`);
      text = (r.json?.output ?? []).flatMap((o: any) => o.content ?? []).map((c: any) => c.text ?? '').join('');
      inT = r.json?.usage?.input_tokens ?? 0;
      outT = r.json?.usage?.output_tokens ?? 0;
    } else if (provider === 'anthropic') {
      const r = await post('https://api.anthropic.com/v1/messages', { 'x-api-key': cfg.anthropicKey!, 'anthropic-version': '2023-06-01' }, { model, max_tokens: maxTokens, ...(opts.system ? { system: opts.system } : {}), messages: [{ role: 'user', content: prompt }] }, timeout);
      if (r.status >= 400) throw new Error(`Anthropic ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 200)}`);
      text = (r.json?.content ?? []).map((b: any) => b.text ?? '').join('');
      inT = r.json?.usage?.input_tokens ?? 0;
      outT = r.json?.usage?.output_tokens ?? 0;
    } else if (provider === 'gemini') {
      const gbody = { ...(opts.system ? { systemInstruction: { parts: [{ text: opts.system }] } } : {}), contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: maxTokens } };
      const gcall = (m: string) => post(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(m)}:generateContent`, { 'x-goog-api-key': cfg.geminiKey! }, gbody, timeout);
      let r = await gcall(model);
      if ([429, 503, 529].includes(r.status) && !opts.noFallback) {
        const fb = await tryGeminiFallbacks(cfg, model, gcall);
        if (fb.r) r = fb.r;
      }
      if (r.status >= 400) throw new Error(geminiError(r, model));
      text = (r.json?.candidates?.[0]?.content?.parts ?? []).map((p: any) => p.text ?? '').join('');
      inT = r.json?.usageMetadata?.promptTokenCount ?? 0;
      outT = r.json?.usageMetadata?.candidatesTokenCount ?? 0;
    } else {
      const r = await post('https://api.perplexity.ai/chat/completions', { authorization: `Bearer ${cfg.perplexityKey}` }, { model, max_tokens: maxTokens, messages: [...(opts.system ? [{ role: 'system', content: opts.system }] : []), { role: 'user', content: prompt }], disable_search: true }, timeout);
      if (r.status >= 400) throw new Error(`Perplexity ${r.status}: ${r.json?.error?.message ?? r.text.slice(0, 200)}`);
      text = r.json?.choices?.[0]?.message?.content ?? '';
      inT = r.json?.usage?.prompt_tokens ?? 0;
      outT = r.json?.usage?.completion_tokens ?? 0;
    }
    return { text, provider, model, inputTokens: inT, outputTokens: outT, costUsd: (inT * PRICE[provider].in + outT * PRICE[provider].out) / 1e6 };
  } catch (e) {
    const msg = (e as Error).name === 'AbortError' ? 'Timeout' : (e as Error).message;
    return { text: '', provider, model, inputTokens: 0, outputTokens: 0, costUsd: 0, error: msg };
  }
}

/** Extrage primul obiect/array JSON valid dintr-un text (tolerant la ```json și text în jur). */
export function parseJsonLoose<T>(text: string): T | null {
  const cleaned = text.replace(/```(?:json)?/gi, '').trim();
  for (const [open, close] of [['{', '}'], ['[', ']']] as const) {
    const start = cleaned.indexOf(open);
    if (start < 0) continue;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < cleaned.length; i++) {
      const ch = cleaned[i];
      if (inStr) {
        if (esc) esc = false;
        else if (ch === '\\') esc = true;
        else if (ch === '"') inStr = false;
        continue;
      }
      if (ch === '"') inStr = true;
      else if (ch === open) depth++;
      else if (ch === close && --depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1)) as T;
        } catch {
          break;
        }
      }
    }
  }
  return null;
}

const JSON_SYSTEM = 'You are a precise analyst. Reply with ONE valid JSON value only, no prose, no markdown fences.';

export async function llmJson<T>(prompt: string, cfg: EngineConfig, opts: { maxTokens?: number } = {}): Promise<{ data: T | null; usage: LlmResult }> {
  let r = await llmText(prompt, cfg, { system: JSON_SYSTEM, maxTokens: opts.maxTokens });
  let data = r.error ? null : parseJsonLoose<T>(r.text);
  if (!data && !r.error) {
    const r2 = await llmText(`${prompt}\n\nIMPORTANT: your previous reply was not valid JSON. Reply with valid JSON only.`, cfg, { system: JSON_SYSTEM, maxTokens: opts.maxTokens });
    data = r2.error ? null : parseJsonLoose<T>(r2.text);
    r = { ...r2, costUsd: r.costUsd + r2.costUsd, inputTokens: r.inputTokens + r2.inputTokens, outputTokens: r.outputTokens + r2.outputTokens };
  }
  return { data, usage: r };
}

/** Mască pentru chei în mesaje de diagnostic: prefix + lungime, niciodată cheia întreagă. */
export function maskKey(k?: string): string {
  if (!k) return 'lipsă';
  const t = k.trim();
  return `${t.slice(0, 7)}… (${t.length} caractere${t !== k ? ', cu spații în jur' : ''})`;
}

/** Diagnostic rapid pentru o cheie, fără apel de rețea. */
export function keyHint(provider: Provider, k?: string): string | null {
  if (!k) return null;
  const t = k.trim();
  if (/^["']|["']$/.test(t)) return 'Cheia conține ghilimele; scoateți-le din .env.';
  // Cheie pusă la alt furnizor (greșeală frecventă la completarea .env).
  const looksGoogle = /^(AIza|AQ\.)/.test(t);
  const looksAnthropic = t.startsWith('sk-ant-');
  const looksPplx = t.startsWith('pplx-');
  if (provider !== 'gemini' && looksGoogle) return 'Aceasta este o cheie Google Gemini (AI Studio). Mutați-o la GEMINI_API_KEY în .env.';
  if (provider !== 'anthropic' && looksAnthropic) return 'Aceasta este o cheie Anthropic. Mutați-o la ANTHROPIC_API_KEY în .env.';
  if (provider !== 'perplexity' && looksPplx) return 'Aceasta este o cheie Perplexity. Mutați-o la PERPLEXITY_API_KEY în .env.';
  if (provider === 'anthropic' && t.startsWith('sk-ant-oat')) return 'Este un token OAuth de abonament Claude, nu o cheie API. Creați o cheie în console.anthropic.com → API Keys (începe cu sk-ant-api).';
  if (provider === 'anthropic' && !t.startsWith('sk-ant-')) return 'Cheile Anthropic încep cu „sk-ant-api…”.';
  if (provider === 'openai' && !t.startsWith('sk-')) return 'Cheile OpenAI încep cu „sk-”.';
  if (provider === 'perplexity' && !t.startsWith('pplx-')) return 'Cheile Perplexity încep cu „pplx-”.';
  if (provider === 'gemini' && !looksGoogle) return 'Cheile Gemini (AI Studio) încep de regulă cu „AIza” sau „AQ.”.';
  return null;
}

// ── Modele Gemini: listă reală de la Google + alegerea automată a unui model de rezervă
const MODEL_NAME = /^[a-z0-9][a-z0-9.\-]{2,80}$/i;
let geminiModelsCache: { key: string; at: number; models: string[] } | null = null;

/** Modelele Gemini care acceptă generateContent pentru această cheie (cele „flash” primele). */
export async function listGeminiModels(key?: string): Promise<string[]> {
  if (!key) return [];
  if (geminiModelsCache && geminiModelsCache.key === key && Date.now() - geminiModelsCache.at < 3600_000) return geminiModelsCache.models;
  try {
    const res = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': key } });
    if (!res.ok) return [];
    const j: any = await res.json();
    const names: string[] = (j.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m: any) => String(m.name).replace(/^models\//, ''))
      .filter((n: string) => /^gemini-/.test(n) && !/(tts|image|embedding|audio|live|vision|preview-\d{2}-\d{2}|exp)/i.test(n));
    const sorted = names.sort((a, b) => Number(/flash/.test(b)) - Number(/flash/.test(a)) || Number(/lite/.test(a)) - Number(/lite/.test(b)) || b.localeCompare(a, undefined, { numeric: true }));
    geminiModelsCache = { key, at: Date.now(), models: sorted };
    return sorted;
  } catch {
    return [];
  }
}

/** Ordine de preferință pentru rezervă: versiuni stabile „flash” (cea mai nouă întâi), apoi aliasuri „-latest”,
 *  apoi „lite”, apoi alte familii; modelele „preview”/experimentale la final (sunt cele mai instabile). */
function fallbackRank(m: string): number {
  let r = 0;
  if (!/flash/.test(m)) r += 40;
  if (/preview|exp/.test(m)) r += 30;
  if (/omni/.test(m)) r += 8;
  if (/latest/.test(m)) r += 5;
  if (/lite/.test(m)) r += 3;
  return r;
}
let lastGoodFallback: string | null = null;

/** Candidații de rezervă (max. 3), în ordinea în care merită încercați. */
export async function geminiFallbacks(cfg: EngineConfig, primary = cfg.geminiModel): Promise<string[]> {
  const set = cfg.geminiFallbackModel?.trim();
  const out: string[] = [];
  if (set && set.toLowerCase() !== 'auto' && MODEL_NAME.test(set) && set !== primary) out.push(set);
  if (lastGoodFallback && lastGoodFallback !== primary) out.push(lastGoodFallback);
  const list = (await listGeminiModels(cfg.geminiKey))
    .filter((m) => m !== primary)
    .sort((a, b) => fallbackRank(a) - fallbackRank(b) || b.localeCompare(a, undefined, { numeric: true }));
  for (const m of list) out.push(m);
  return [...new Set(out)].slice(0, 3);
}

/** Primul candidat de rezervă (compatibilitate). */
export async function geminiFallback(cfg: EngineConfig, primary = cfg.geminiModel): Promise<string | null> {
  return (await geminiFallbacks(cfg, primary))[0] ?? null;
}

/** Încearcă pe rând modelele de rezervă; întoarce primul răspuns reușit și ce s-a încercat. */
export async function tryGeminiFallbacks<R extends { status: number; json?: any; text: string }>(
  cfg: EngineConfig,
  primary: string,
  call: (model: string) => Promise<R>,
): Promise<{ r: R | null; model: string | null; tried: string[] }> {
  const tried: string[] = [];
  for (const m of await geminiFallbacks(cfg, primary)) {
    const r = await call(m);
    if (r.status < 400) {
      lastGoodFallback = m;
      return { r, model: m, tried };
    }
    tried.push(`${m} (${r.status}${r.json?.error?.message ? ': ' + String(r.json.error.message).slice(0, 80) : ''})`);
  }
  return { r: null, model: null, tried };
}

/** Eroare Gemini lizibilă. La 429 adaugă tipul cotei (pe zi / pe minut) și cât trebuie așteptat, din error.details. */
export function geminiError(r: { status: number; json?: any; text: string }, model?: string): string {
  const err = r.json?.error ?? {};
  let msg = `Gemini ${r.status}: ${String(err.message ?? r.text.slice(0, 300)).split('\n')[0].replace(/\s*For more information.*$/i, '').trim()}`;
  if (r.status === 429) {
    const details: any[] = Array.isArray(err.details) ? err.details : [];
    const ids = details.flatMap((d) => (d.violations ?? []).map((v: any) => `${v.quotaId ?? ''} ${v.quotaMetric ?? ''}`)).join(' ');
    const delay = details.find((d) => d.retryDelay)?.retryDelay as string | undefined;
    const perDay = /PerDay/i.test(ids);
    const perMin = /PerMinute/i.test(ids);
    const parts = [perDay ? 'cotă zilnică epuizată' : perMin ? 'limită pe minut' : '', /FreeTier/i.test(ids) ? 'nivel gratuit' : '', model ? `model ${model}` : '', delay ? `reîncercare după ${delay}` : ''].filter(Boolean);
    if (parts.length) msg += ` [${parts.join('; ')}]`;
  }
  return msg;
}

/** Secunde de așteptat la o eroare 429 (din „reîncercare după 34s”), sau undefined. */
export function retryAfterSeconds(error: string): number | undefined {
  const m = error.match(/reîncercare după (\d+(?:\.\d+)?)s/);
  return m ? Math.ceil(Number(m[1])) : undefined;
}

/** Cota zilnică e epuizată: nu are sens să reîncercăm azi. */
export function isDailyQuota(error: string): boolean {
  return /cotă zilnică epuizată|PerDay/i.test(error);
}
