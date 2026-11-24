// Cercetarea prompturilor (echivalentul „Prompt Research” din Semrush / „Prompt Suggestions” din Moz).
// 1) Cu LLM: întrebări realiste generate din profilul brandului, pe topicuri × intenții × etape × limbi.
// 2) Fără LLM: șabloane pe topicuri, adaptate la acoperire (local / național).
// Prompturile de descoperire NU conțin numele brandului — altfel măsurătoarea e falsificată.

import type { EngineConfig } from './engines.ts';
import { llmJson } from './llm.ts';
import type { Lang, Project, PromptDef, PromptIntent } from './types.ts';
import { normalize } from './util.ts';

export interface GeneratedPrompt {
  text: string;
  lang: Lang;
  intent: PromptIntent;
  tags: string[];
  topic?: string;
  stage?: PromptDef['stage'];
  origin: 'ai' | 'template';
}

interface Tpl {
  intent: PromptIntent;
  stage: PromptDef['stage'];
  ro: string;
  local?: boolean; // doar pentru business local
  national?: boolean; // doar pentru acoperire națională/online
}

const TPL: Tpl[] = [
  { intent: 'category', stage: 'awareness', ro: 'Care sunt cele mai bune opțiuni pentru {topic} în {where}?' },
  { intent: 'category', stage: 'awareness', ro: 'Recomandă-mi unde să găsesc {topic} de calitate în {where}.' },
  { intent: 'local', stage: 'consideration', ro: 'Recomandări pentru {topic} în zona {hood}, {city}', local: true },
  { intent: 'use_case', stage: 'consideration', ro: 'Ce să aleg pentru {topic} dacă sunt la prima achiziție și nu vreau să greșesc?' },
  { intent: 'price', stage: 'consideration', ro: 'Unde găsesc {topic} la cel mai bun raport calitate-preț în {where}?' },
  { intent: 'trust', stage: 'decision', ro: 'De la cine e sigur să cumpăr {topic} în {where}? Cine are recenzii bune și retur ușor?', national: true },
  { intent: 'trust', stage: 'decision', ro: 'Ce {category} din {city} are cele mai bune recenzii pentru {topic}?', local: true },
  { intent: 'comparison', stage: 'decision', ro: '{comp} sau alte variante pentru {topic}? Ce alternative recomanzi?' },
];

function fill(t: string, v: Record<string, string>): string {
  return t.replace(/\{(\w+)\}/g, (_, k: string) => v[k] ?? '').replace(/\s+/g, ' ').replace(/ ([,.?])/g, '$1').trim();
}

function topicsOf(p: Project): string[] {
  const t = [...(p.topics ?? []).map((x) => x.name), ...p.services].map((x) => x.trim()).filter(Boolean);
  const seen = new Map<string, string>();
  for (const x of t) if (!seen.has(normalize(x))) seen.set(normalize(x), x);
  return [...seen.values()].slice(0, 10);
}

export function isLocal(p: Project): boolean {
  return p.scope ? p.scope === 'local' : p.vertical === 'restaurant' || p.vertical === 'local_service';
}

/** Promptul de brand: măsoară acuratețea (adresă, program, prețuri), nu descoperirea. */
export function brandPrompts(p: Project): GeneratedPrompt[] {
  const where = isLocal(p) && p.city ? ` din ${p.city}` : '';
  return [
    { text: `Ce știi despre ${p.name}${where}? Ce oferă, cât de bune sunt recenziile și cum se compară cu alternativele?`, lang: 'ro', intent: 'brand', tags: ['brand'], stage: 'decision', origin: 'template' },
    ...(isLocal(p) ? [{ text: `Care este adresa, programul și telefonul ${p.name}${where}?`, lang: 'ro' as Lang, intent: 'brand' as PromptIntent, tags: ['brand', 'acuratețe'], stage: 'decision' as const, origin: 'template' as const }] : []),
  ];
}

export function generatePrompts(p: Project, max = 30): GeneratedPrompt[] {
  const local = isLocal(p);
  const topics = topicsOf(p);
  if (!topics.length) topics.push(p.category || 'produsele pe care le căutați');
  const comps = p.competitors.map((c) => c.name);
  const where = local ? p.city ?? 'orașul meu' : p.country === 'RO' ? 'România' : p.country;
  const out: GeneratedPrompt[] = [];
  const seen = new Set<string>();
  topics.forEach((topic, ti) => {
    TPL.forEach((t, i) => {
      if (t.local && !local) return;
      if (t.national && local) return;
      if (t.ro.includes('{comp}') && !comps.length) return;
      if (t.ro.includes('{hood}') && !p.neighborhoods.length) return;
      if (t.ro.includes('{category}') && !p.category) return;
      const text = fill(t.ro, { topic: topic.toLowerCase(), where, city: p.city ?? '', hood: p.neighborhoods[(ti + i) % Math.max(1, p.neighborhoods.length)] ?? '', comp: comps[(ti + i) % Math.max(1, comps.length)] ?? '', category: p.category ?? '' });
      const k = normalize(text);
      if (seen.has(k)) return;
      seen.add(k);
      out.push({ text, lang: 'ro', intent: t.intent, stage: t.stage, tags: [topic, t.intent], topic, origin: 'template' });
    });
  });
  // Echilibrăm: câte un prompt din fiecare topic pe rând, ca setul să acopere toate topicurile.
  const byTopic = new Map<string, GeneratedPrompt[]>();
  out.forEach((g) => byTopic.set(g.topic!, [...(byTopic.get(g.topic!) ?? []), g]));
  const result: GeneratedPrompt[] = [];
  while (result.length < max - 1 && [...byTopic.values()].some((a) => a.length)) for (const a of byTopic.values()) if (a.length && result.length < max - 1) result.push(a.shift()!);
  return [...result, ...brandPrompts(p).slice(0, 1)];
}

/** Generare cu LLM: întrebări cum le scriu oamenii reali în ChatGPT, pe fiecare topic, intenție și etapă. */
export async function generatePromptsAI(p: Project, cfg: EngineConfig, opts: { perTopic?: number; topics?: string[]; existing?: string[] } = {}): Promise<{ prompts: GeneratedPrompt[]; costUsd: number; error?: string }> {
  const topics = opts.topics?.length ? opts.topics : topicsOf(p);
  if (!topics.length) return { prompts: [], costUsd: 0, error: 'Adăugați cel puțin un topic sau serviciu.' };
  const perTopic = opts.perTopic ?? 5;
  const langs = p.languages.length ? p.languages : ['ro'];
  const prompt = `You generate realistic prompts that real people type into AI assistants (ChatGPT, Gemini, Perplexity, Claude) when they are looking for what this business offers. These prompts are used to MEASURE which brands the AI recommends.

Business: ${p.name} (${p.domain})
Category: ${p.category || p.vertical}
Description: ${p.description ?? p.facts.description ?? ''}
Scope: ${isLocal(p) ? `local, city ${p.city ?? '?'}${p.neighborhoods.length ? `, areas: ${p.neighborhoods.join(', ')}` : ''}` : `${p.scope ?? 'national'}, country ${p.country}`}
Buyer personas: ${(p.personas ?? []).map((x) => `${x.name}: ${x.description}`).join(' | ') || 'n/a'}
Known competitors: ${p.competitors.map((c) => c.name).join(', ') || 'n/a'}
Topics: ${topics.join(' | ')}
Languages: ${langs.join(', ')} (Romanian prompts must use correct diacritics)
${opts.existing?.length ? `Already tracked (do not repeat): ${opts.existing.slice(0, 40).join(' | ')}` : ''}

Rules:
- ${perTopic} prompts per topic per language, natural conversational phrasing, 6-25 words, as a real buyer would ask.
- NEVER include "${p.name}" or its aliases. At most 1 prompt per topic may name a competitor (comparison/alternatives).
- Mix intents: category (best X), use_case (X for a specific need), price (budget/value), trust (reliable, reviews, returns), comparison (X vs Y / alternatives)${isLocal(p) ? ', local (near an area)' : ''}.
- Mix stages: awareness, consideration, decision.
- ${isLocal(p) ? 'Include the city or an area in most prompts.' : 'Do not include a city unless it is natural; the market is the country.'}

Return JSON: {"prompts":[{"text":string,"topic":string (one of the topics),"intent":"category"|"use_case"|"price"|"trust"|"comparison"|"local","stage":"awareness"|"consideration"|"decision","lang":"ro"|"en"}]}`;
  const { data, usage } = await llmJson<{ prompts: { text: string; topic?: string; intent?: string; stage?: string; lang?: string }[] }>(prompt, cfg, { maxTokens: 4000 });
  if (!data?.prompts) return { prompts: [], costUsd: usage.costUsd, error: usage.error ?? 'Răspuns AI invalid.' };
  const intents: PromptIntent[] = ['category', 'comparison', 'use_case', 'local', 'price', 'trust'];
  const own = [p.name, ...p.aliases].map(normalize);
  const seen = new Set((opts.existing ?? []).map(normalize));
  const out: GeneratedPrompt[] = [];
  for (const x of data.prompts) {
    const text = String(x.text ?? '').trim();
    const k = normalize(text);
    if (text.length < 8 || seen.has(k) || own.some((o) => o && k.includes(o))) continue;
    seen.add(k);
    const intent = intents.includes(x.intent as PromptIntent) ? (x.intent as PromptIntent) : 'category';
    const topic = topics.find((t) => normalize(t) === normalize(x.topic ?? '')) ?? x.topic ?? topics[0];
    out.push({ text, lang: x.lang === 'en' ? 'en' : 'ro', intent, stage: (['awareness', 'consideration', 'decision'] as const).find((s) => s === x.stage) ?? 'consideration', topic, tags: [topic, intent], origin: 'ai' });
  }
  return { prompts: out, costUsd: usage.costUsd };
}
