// Optimizatorul de conținut (echivalentul „AI Content Briefs” / content checks din Moz, Otterly, Semrush):
// analizează o pagină pentru o întrebare țintă, o compară cu paginile pe care AI-ul le citează deja
// pentru acea întrebare și propune rescrieri concrete. Scorul de bază e determinist; LLM-ul adaugă rescrierile.

import type { EngineConfig } from './engines.ts';
import { parseHtml, looksJsOnly } from './html.ts';
import { llmJson } from './llm.ts';
import type { Project } from './types.ts';
import { httpGet, normalize } from './util.ts';

export interface PageSignals {
  url: string;
  status: number;
  title: string;
  h1: string;
  words: number;
  questionHeadings: number;
  headings: number;
  lists: number;
  tables: boolean;
  facts: number;
  factsPer1k: number;
  schemaTypes: string[];
  answersEarly: boolean; // termenii întrebării apar în primele ~80 de cuvinte
  avgSentence: number;
  jsOnly: boolean;
  dated: boolean;
  outboundCitations: number;
  score: number;
  checks: { label: string; ok: boolean; detail: string }[];
}

export interface OptimizeResult {
  target: PageSignals;
  competitors: PageSignals[];
  question: string;
  ai?: {
    verdict: string;
    score: number;
    directAnswer: string;
    missingFacts: string[];
    issues: { issue: string; fix: string }[];
    faq: { q: string; a: string }[];
    outline: string[];
  };
  aiError?: string;
  costUsd: number;
}

const STOP = new Set(['care', 'este', 'sunt', 'pentru', 'cele', 'cel', 'mai', 'bune', 'bun', 'unde', 'cum', 'ce', 'din', 'in', 'la', 'de', 'si', 'cu', 'the', 'best', 'what', 'where', 'how', 'for', 'and', 'with', 'recomanda', 'recomandami', 'imi']);

export function pageSignals(url: string, status: number, html: string, question: string): PageSignals {
  const p = parseHtml(html);
  const words = p.words;
  const facts = (p.text.match(/\b\d+([.,]\d+)?\s?(%|ani|km|minute|min|kg|g|ore|zile|lei|ron|€|eur|\$|clienți|clienti|comenzi|produse|recenzii|stele|ani de)\b/gi) ?? []).length;
  const terms = normalize(question).split(/[^a-z0-9]+/).filter((w) => w.length > 3 && !STOP.has(w));
  const early = normalize(p.text.split(/\s+/).slice(0, 80).join(' '));
  const answersEarly = terms.length ? terms.filter((t) => early.includes(t.slice(0, Math.max(4, t.length - 2)))).length >= Math.ceil(terms.length / 2) : false;
  const sentences = p.text.split(/[.!?]+\s/).filter((x) => x.trim().split(/\s+/).length > 3);
  const avgSentence = sentences.length ? sentences.reduce((s, x) => s + x.split(/\s+/).length, 0) / sentences.length : 0;
  const host = (() => {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  })();
  const outbound = p.links.filter((l) => /^https?:/.test(l.href) && !l.href.includes(host)).length;
  const checks = [
    { label: 'Răspuns direct la început', ok: answersEarly, detail: answersEarly ? 'Termenii întrebării apar în primele 80 de cuvinte.' : 'Primele 80 de cuvinte nu răspund la întrebare.' },
    { label: 'Un H1 clar', ok: p.h1.length === 1, detail: p.h1.length ? `H1: „${p.h1[0]}”` : 'Lipsește H1.' },
    { label: 'Titluri-întrebare', ok: p.questionHeadings.length >= 3, detail: `${p.questionHeadings.length} titluri formulate ca întrebări.` },
    { label: 'Structură scanabilă', ok: p.h2.length + p.h3.length >= 4 && (p.listItems >= 5 || p.hasTable), detail: `${p.h2.length + p.h3.length} subtitluri, ${p.listItems} elemente de listă${p.hasTable ? ', tabel' : ''}.` },
    { label: 'Fapte și cifre', ok: words > 0 && (facts / words) * 1000 >= 4, detail: `${facts} fapte numerice (${words ? ((facts / words) * 1000).toFixed(1) : 0}/1000 cuvinte).` },
    { label: 'Lungime suficientă', ok: words >= 400, detail: `${words} cuvinte.` },
    { label: 'Fraze scurte', ok: avgSentence > 0 && avgSentence <= 22, detail: `${avgSentence.toFixed(0)} cuvinte/frază în medie.` },
    { label: 'Date structurate', ok: p.schemaTypes.length > 0, detail: p.schemaTypes.slice(0, 6).join(', ') || 'Fără JSON-LD.' },
    { label: 'Conținut vizibil fără JavaScript', ok: !looksJsOnly(p, html), detail: looksJsOnly(p, html) ? 'Pagina pare goală fără JS.' : 'OK.' },
    { label: 'Dată de actualizare', ok: !!p.modified, detail: p.modified || 'Nu afișează data actualizării.' },
    { label: 'Surse externe citate', ok: outbound >= 2, detail: `${outbound} linkuri externe.` },
  ];
  const score = Math.round((checks.filter((c) => c.ok).length / checks.length) * 100);
  return { url, status, title: p.title, h1: p.h1[0] ?? '', words, questionHeadings: p.questionHeadings.length, headings: p.h2.length + p.h3.length, lists: p.listItems, tables: p.hasTable, facts, factsPer1k: words ? (facts / words) * 1000 : 0, schemaTypes: p.schemaTypes, answersEarly, avgSentence, jsOnly: looksJsOnly(p, html), dated: !!p.modified, outboundCitations: outbound, score, checks };
}

export async function optimizePage(p: Project, url: string, question: string, competitorUrls: string[], cfg: EngineConfig): Promise<OptimizeResult> {
  const t = await httpGet(url, { timeoutMs: 20000 });
  const target = pageSignals(url, t.status, t.body, question);
  const comps: PageSignals[] = [];
  const compTexts: string[] = [];
  for (const cu of competitorUrls.slice(0, 3)) {
    const r = await httpGet(cu, { timeoutMs: 15000 });
    if (r.status >= 200 && r.status < 300 && r.body) {
      comps.push(pageSignals(cu, r.status, r.body, question));
      compTexts.push(`URL: ${cu}\n${parseHtml(r.body).text.split(/\s+/).slice(0, 500).join(' ')}`);
    }
  }
  const res: OptimizeResult = { target, competitors: comps, question, costUsd: 0 };
  if (!t.body) return { ...res, aiError: t.error ?? `Pagina a răspuns cu ${t.status}.` };
  const pageText = parseHtml(t.body).text.split(/\s+/).slice(0, 1800).join(' ');
  const prompt = `You are a GEO (generative engine optimization) editor. Improve this page so AI assistants (ChatGPT, Gemini, Perplexity, Claude) can extract and cite it when users ask the target question.

Brand: ${p.name} (${p.domain}). Target question: "${question}"
Language for all output: Romanian (with diacritics).

PAGE (${url}):
${pageText}

${compTexts.length ? `PAGES AI ALREADY CITES FOR THIS QUESTION:\n${compTexts.join('\n---\n').slice(0, 6000)}` : ''}

Return JSON:
{"verdict": string (2 sentences: why AI would or would not cite this page),
 "score": number 0-100,
 "directAnswer": string (a 2-3 sentence answer paragraph to put at the top, using ONLY facts present on the page; use [COMPLETAȚI] where a fact is missing),
 "missingFacts": string[] (facts the cited pages give that this page lacks, max 8),
 "issues": [{"issue": string, "fix": string}] (max 8, concrete),
 "faq": [{"q": string, "a": string}] (5 questions real buyers ask; answers only from page facts or [COMPLETAȚI]),
 "outline": string[] (recommended H2 structure, max 8)}`;
  const { data, usage } = await llmJson<NonNullable<OptimizeResult['ai']>>(prompt, cfg, { maxTokens: 3000 });
  return { ...res, ai: data ?? undefined, aiError: data ? undefined : usage.error ?? 'Fără furnizor LLM sau răspuns invalid.', costUsd: usage.costUsd };
}
