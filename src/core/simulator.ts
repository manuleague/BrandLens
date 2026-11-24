// Simulator pentru proiectul demo: răspunsuri sintetice, deterministe, ca să poți explora aplicația fără chei API.
// Toate rezultatele sunt marcate `simulated: true` și afișate cu banner în interfață.

import type { Citation, EngineId, EngineResult, Project } from './types.ts';

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function rng(seed: number): () => number {
  let a = seed || 1;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const EXTRA = ['Trattoria del Borgo', 'Forno Rustico', 'Casa Napoli', 'Pizza Corner Iași', 'La Gustul Bun'];
const SRC: Record<EngineId, string[]> = {
  chatgpt: ['tripadvisor.com', 'restaurantguru.com', 'foursquare.com', 'iasifun.ro', 'facebook.com', 'bing.com/maps'],
  gemini: ['maps.google.com', 'google.com', 'tripadvisor.com', 'glovoapp.com'],
  perplexity: ['tripadvisor.com', 'reddit.com', 'iasifun.ro', 'ziaruldeiasi.ro', 'restaurantguru.com', 'wanderlog.com', 'tazz.ro', 'youtube.com'],
  claude: ['tripadvisor.com', 'iasifun.ro', 'restaurantguru.com', 'ziaruldeiasi.ro'],
  simulator: ['example.com'],
};
const BASE_P: Record<EngineId, number> = { chatgpt: 0.12, gemini: 0.4, perplexity: 0.22, claude: 0.15, simulator: 0.3 };

/** progress 0..1 = cât din planul de acțiuni a fost implementat (crește vizibilitatea în demo). */
export function simulateAnswer(p: Project, prompt: string, engine: EngineId, seed: string, progress = 0): Omit<EngineResult, 'latencyMs'> {
  const r = rng(hash(`${prompt}|${engine}|${seed}`));
  const brand = /ce știi despre/i.test(prompt);
  const pool = [...p.competitors.map((c) => c.name), ...EXTRA];
  const pOwn = brand ? 1 : Math.min(0.9, BASE_P[engine] + progress * 0.45);
  const includeOwn = r() < pOwn;
  const picks: string[] = [];
  while (picks.length < 4 + Math.floor(r() * 2) && pool.length) picks.push(pool.splice(Math.floor(r() * pool.length), 1)[0]);
  if (includeOwn) picks.splice(Math.floor(r() * Math.min(picks.length, progress > 0.5 ? 2 : 4)), 0, p.name);
  const city = p.city ?? 'oraș';
  const desc = [
    'aluat fermentat lung și cuptor pe lemne, foarte apreciată în recenzii',
    'porții generoase și prețuri accesibile, populară printre studenți',
    'atmosferă de familie, livrare rapidă în majoritatea cartierelor',
    'ingrediente italiene, opțiuni vegetariene; unele recenzii menționează timpi de așteptare lungi',
    'deschisă până târziu, potrivită pentru grupuri',
  ];
  const lines = brand
    ? [`${p.name} este o pizzerie din ${city}${p.facts.address ? `, situată pe ${r() < 0.85 ? p.facts.address : 'Str. Lăpușneanu 10'}` : ''}. ${r() < 0.8 ? `Telefon: ${p.facts.phone ?? '0700 000 000'}.` : 'Telefon: 0232 111 222.'} Recenziile o descriu drept ${desc[Math.floor(r() * 3)]}.`]
    : [
        `Iată câteva opțiuni bune pentru „${prompt.replace(/\?$/, '')}”:`,
        '',
        ...picks.map((n, i) => `${i + 1}. **${n}** – ${desc[Math.floor(r() * desc.length)]}.`),
        '',
        r() < 0.5 ? 'Recomand să verificați programul înainte, deoarece poate varia în weekend.' : 'Prețurile medii sunt între 35 și 60 de lei pentru o pizza.',
      ];
  const srcPool = [...SRC[engine]];
  const cits: Citation[] = [];
  const nSrc = 2 + Math.floor(r() * (engine === 'perplexity' ? 6 : 3));
  for (let i = 0; i < nSrc && srcPool.length; i++) {
    const d = srcPool.splice(Math.floor(r() * srcPool.length), 1)[0];
    cits.push({ url: `https://${d}/${encodeURIComponent(city.toLowerCase())}-pizza-${i}`, title: `Top pizzerii ${city} — ${d}`, domain: d.split('/')[0], kind: 'cited' });
  }
  if (includeOwn && r() < 0.25 + progress * 0.4) cits.push({ url: `https://${p.domain}/meniu`, title: `${p.name} — Meniu`, domain: p.domain, kind: 'cited' });
  const comp = p.competitors.find((c) => c.domain && picks.includes(c.name));
  if (comp && r() < 0.4) cits.push({ url: `https://${comp.domain}/`, title: comp.name, domain: comp.domain!, kind: 'cited' });
  return {
    engine,
    model: `sim-${engine}`,
    text: lines.join('\n'),
    citations: cits,
    searchQueries: fanout(prompt, city, r),
    usage: { inputTokens: 0, outputTokens: 0, searches: 1, costUsd: 0 },
    simulated: true,
  };
}

/** Interogări de căutare sintetice, ca cele pe care motoarele le fac în fundal („fan-out”). */
function fanout(prompt: string, city: string, r: () => number): string[] {
  const core = prompt.toLowerCase().replace(/[?.!,]/g, '').split(/\s+/).filter((w) => w.length > 3 && !/^(care|este|cele|pentru|unde|recomand|recomandă-mi|găsesc|calitate)/.test(w)).slice(0, 4).join(' ');
  const pool = [normalizeCity(core, city), `cea mai bună pizzerie ${city} recenzii`, `top pizzerii ${city} 2026`, `${core} prețuri`, `pizza livrare ${city} rapid`];
  const n = 1 + Math.floor(r() * 3);
  return pool.slice(0, n);
}

function normalizeCity(core: string, city: string): string {
  return core.toLowerCase().includes(city.toLowerCase()) ? core : `${core} ${city}`;
}
