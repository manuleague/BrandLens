// Auditul GEO: 32 de verificări în 5 piloni, scor /100. Verificările „manuale” se bifează în Acțiuni.

import { findSchemaNode } from './html.ts';
import type { CrawlData, CrawledPage } from './crawler.ts';
import type { AuditResult, CheckStatus, Finding, Pillar, Project } from './types.ts';
import { normalize, phoneKey } from './util.ts';

export interface TrackingSummary {
  enginesRun: number;
  n: number;
  visibility: number;
  citationRate: number;
  accuracyIssues: number;
  topThirdParty: number; // câte domenii terțe frecvent citate
  topThirdPartyWithOwn: number; // în câte dintre ele apare brandul
}

export interface AuditContext {
  project: Project;
  crawl: CrawlData;
  tracking?: TrackingSummary;
  manualDone: Set<string>; // id-uri de verificări bifate manual (acțiuni done/verified)
}

export const PILLAR_LABEL: Record<Pillar, string> = {
  access: 'Acces AI & tehnic',
  entity: 'Entitate & date structurate',
  content: 'Conținut „answer-ready”',
  offsite: 'Prezență locală & surse terțe',
  visibility: 'Vizibilitate AI & măsurare',
};

const LOCAL = new Set(['restaurant', 'local_service']);
const BIZ_TYPES = ['Organization', 'LocalBusiness', 'Restaurant', 'FoodEstablishment', 'Store', 'ProfessionalService', 'Corporation', 'OnlineStore', 'MedicalBusiness', 'HomeAndConstructionBusiness', 'AutomotiveBusiness', 'LodgingBusiness', 'BarOrPub', 'CafeOrCoffeeShop', 'Bakery', 'Dentist', 'LegalService'];

type Eval = { status: CheckStatus; detail: string; evidence?: string[] };
interface CheckDef {
  id: string;
  pillar: Pillar;
  title: string;
  weight: number;
  manual?: boolean;
  applies?: (c: AuditContext) => boolean;
  run: (c: AuditContext) => Eval;
}

const pagesOk = (c: AuditContext) => c.crawl.pages.filter((p) => p.status >= 200 && p.status < 300);
const allText = (c: AuditContext) => pagesOk(c).map((p) => p.parsed.text).join('\n');
const findPage = (c: AuditContext, re: RegExp): CrawledPage | undefined =>
  pagesOk(c).find((p) => re.test(p.url) || re.test(p.parsed.title) || p.parsed.h1.some((h) => re.test(h)));
const bizNode = (c: AuditContext) => {
  for (const p of pagesOk(c)) {
    const n = findSchemaNode(p.parsed.jsonLd, BIZ_TYPES);
    if (n) return { node: n, page: p };
  }
  return null;
};
const pct = (x: number) => `${Math.round(x * 100)}%`;
const manualCheck = (hint: string) => (c: AuditContext): Eval => ({ status: 'manual', detail: hint });

const CHECKS: CheckDef[] = [
  // ───────────── A. Acces AI & tehnic (20)
  {
    id: 'home_https_200', pillar: 'access', title: 'Pagina principală răspunde 200 pe HTTPS', weight: 3,
    run: (c) => {
      const f = c.crawl.homeFetch;
      if (!f.status) return { status: 'fail', detail: `Site-ul nu răspunde (${f.error ?? 'fără răspuns'}).` };
      if (f.status >= 400) return { status: 'fail', detail: `Pagina principală întoarce ${f.status}${homeStatusHint(f.status)}.` };
      if (!f.finalUrl.startsWith('https://')) return { status: 'warn', detail: 'Site-ul se servește pe HTTP, nu HTTPS.', evidence: [f.finalUrl] };
      return { status: 'pass', detail: `200 OK în ${f.ms} ms.`, evidence: [f.finalUrl] };
    },
  },
  {
    id: 'robots_ai_search', pillar: 'access', title: 'robots.txt permite crawlerele de căutare AI', weight: 5,
    run: (c) => {
      const critical = c.crawl.bots.filter((b) => b.purpose === 'search' && ['OAI-SearchBot', 'Claude-SearchBot', 'PerplexityBot', 'Googlebot', 'Bingbot'].includes(b.token));
      const blocked = critical.filter((b) => !b.robotsAllowed);
      if (!c.crawl.robots) return { status: c.crawl.robotsStatus === 404 ? 'pass' : 'warn', detail: c.crawl.robotsStatus === 404 ? 'Nu există robots.txt — totul este permis implicit (recomandat totuși un fișier explicit cu Sitemap).' : `robots.txt nu a putut fi citit (status ${c.crawl.robotsStatus}).` };
      if (blocked.length) return { status: 'fail', detail: `Blocate: ${blocked.map((b) => b.token).join(', ')}.`, evidence: blocked.map((b) => `${b.token} → ${b.robotsLine ?? 'regula *'}`) };
      return { status: 'pass', detail: 'OAI-SearchBot, Claude-SearchBot, PerplexityBot, Googlebot și Bingbot au acces.' };
    },
  },
  {
    id: 'waf_bots', pillar: 'access', title: 'Firewall/CDN nu blochează boții AI (test live)', weight: 3,
    run: (c) => {
      const tested = c.crawl.bots.filter((b) => b.liveStatus !== undefined);
      if (!tested.length) return { status: 'na', detail: 'Testul live nu a rulat.' };
      const blocked = tested.filter((b) => b.liveBlocked);
      const ev = blocked.map((b) => `${b.token}: ${b.liveReason ?? `HTTP ${b.liveStatus}`}`);
      // Martorul: Googlebot/Bingbot. Niciun site comercial nu îi blochează intenționat; dacă și ei sunt „blocați”,
      // WAF-ul verifică boții după IP și respinge orice user-agent fals → testul nostru nu poate decide.
      const controls = tested.filter((b) => b.token === 'Googlebot' || b.token === 'Bingbot');
      if (blocked.length && controls.length && controls.every((b) => b.liveBlocked))
        return { status: 'warn', detail: `Neconcludent: site-ul respinge user-agenții de bot falși, inclusiv Googlebot și Bingbot (${blocked.length} din ${tested.length}). E semnul unui WAF care verifică boții după IP; boții reali probabil trec. Confirmați în logurile CDN/server (tab-ul Crawlere AI) că OAI-SearchBot, Claude-SearchBot și PerplexityBot primesc 200.`, evidence: ev };
      const aiBlocked = blocked.filter((b) => !controls.includes(b));
      if (aiBlocked.length) return { status: 'fail', detail: `Boții AI ${aiBlocked.map((b) => b.token).join(', ')} sunt respinși, deși Googlebot/Bingbot trec. Regula de WAF/CDN tratează diferit boții AI; verificați setările de bot management (ex. Cloudflare „Block AI bots”).`, evidence: ev };
      if (blocked.length) return { status: 'warn', detail: `Răspuns diferit pentru ${blocked.map((b) => b.token).join(', ')}. Verificați în logurile CDN.`, evidence: ev };
      return { status: 'pass', detail: `${tested.length} user-agenți AI testați — niciun blocaj detectat.` };
    },
  },
  {
    id: 'sitemap', pillar: 'access', title: 'Sitemap XML valid și declarat', weight: 2,
    run: (c) => {
      if (!c.crawl.sitemapFound) return { status: 'fail', detail: 'Nu s-a găsit sitemap.xml valid (nici în robots.txt).' };
      const sm = c.crawl.sitemap;
      const declared = (c.crawl.robots?.sitemaps.length ?? 0) > 0;
      const desc = `${sm.indexChildren ? `Index cu ${sm.indexChildren} sitemap-uri; ` : ''}${sm.declaredTotal} URL-uri în ${sm.files} fișiere citite (eșantion)`;
      if (!sm.declaredTotal) return { status: 'warn', detail: `${desc}. Sitemap-ul există, dar nu am putut citi URL-uri din el.` };
      return { status: declared ? 'pass' : 'warn', detail: `${desc}${declared ? '' : '; nu e declarat în robots.txt'}.` };
    },
  },
  {
    id: 'server_rendered', pillar: 'access', title: 'Conținutul important e în HTML (nu doar după JavaScript)', weight: 3,
    run: (c) => {
      const js = pagesOk(c).filter((p) => p.jsOnly);
      if (!pagesOk(c).length) return { status: 'fail', detail: 'Nicio pagină nu a putut fi citită.' };
      if (js.length) return { status: js.some((p) => p.url === c.crawl.home?.url) ? 'fail' : 'warn', detail: `${js.length} pagini par goale fără JavaScript — crawlerele AI nu execută de regulă JS.`, evidence: js.map((p) => p.url).slice(0, 5) };
      return { status: 'pass', detail: 'Paginile au text vizibil direct în HTML.' };
    },
  },
  {
    id: 'indexable', pillar: 'access', title: 'Paginile cheie nu au noindex și au canonical corect', weight: 2,
    run: (c) => {
      const ni = pagesOk(c).filter((p) => p.noindex);
      const badCanon = pagesOk(c).filter((p) => p.parsed.canonical && !p.parsed.canonical.startsWith('http') && !p.parsed.canonical.startsWith('/'));
      if (ni.length) return { status: ni.some((p) => p.url === c.crawl.home?.url) ? 'fail' : 'warn', detail: `${ni.length} pagini cu noindex.`, evidence: ni.map((p) => p.url).slice(0, 5) };
      if (badCanon.length) return { status: 'warn', detail: 'Canonical invalid pe unele pagini.', evidence: badCanon.map((p) => p.url) };
      return { status: 'pass', detail: 'Fără noindex pe paginile crawl-uite.' };
    },
  },
  {
    id: 'speed', pillar: 'access', title: 'Timp de răspuns acceptabil', weight: 2,
    run: (c) => {
      const ok = pagesOk(c);
      if (!ok.length) return { status: 'na', detail: '—' };
      const avg = ok.reduce((s, p) => s + p.ms, 0) / ok.length;
      const heavy = ok.filter((p) => p.html.length > 1_500_000);
      if (avg > 2500) return { status: 'fail', detail: `Timp mediu de răspuns ${Math.round(avg)} ms.` };
      if (avg > 1200 || heavy.length) return { status: 'warn', detail: `Timp mediu ${Math.round(avg)} ms${heavy.length ? `; ${heavy.length} pagini HTML > 1,5 MB` : ''}.` };
      return { status: 'pass', detail: `Timp mediu ${Math.round(avg)} ms.` };
    },
  },

  // ───────────── B. Entitate & date structurate (20)
  {
    id: 'schema_business', pillar: 'entity', title: 'JSON-LD Organization/LocalBusiness prezent', weight: 5,
    run: (c) => {
      const b = bizNode(c);
      const errors = pagesOk(c).reduce((s, p) => s + p.parsed.jsonLdErrors, 0);
      if (!b) return { status: 'fail', detail: `Nu există date structurate despre business${errors ? ` (${errors} blocuri JSON-LD invalide)` : ''}.` };
      return { status: errors ? 'warn' : 'pass', detail: `Găsit ${String(b.node['@type'])} pe ${b.page.url}${errors ? `; ${errors} blocuri JSON-LD invalide` : ''}.` };
    },
  },
  {
    id: 'schema_props', pillar: 'entity', title: 'Schema are proprietățile cheie pentru tipul de business', weight: 4,
    run: (c) => {
      const b = bizNode(c);
      if (!b) return { status: 'fail', detail: 'Fără schema de business.' };
      const want = LOCAL.has(c.project.vertical)
        ? ['name', 'address', 'telephone', 'openingHoursSpecification|openingHours', 'geo', 'priceRange', 'url', 'image']
        : ['name', 'url', 'logo', 'sameAs', 'description', 'contactPoint|telephone'];
      if (c.project.vertical === 'restaurant') want.push('servesCuisine', 'hasMenu|menu', 'acceptsReservations');
      const missing = want.filter((k) => !k.split('|').some((kk) => b.node[kk] !== undefined && b.node[kk] !== ''));
      if (!missing.length) return { status: 'pass', detail: 'Toate proprietățile cheie sunt prezente.' };
      return { status: missing.length > want.length / 2 ? 'fail' : 'warn', detail: `Lipsesc: ${missing.join(', ')}.` };
    },
  },
  {
    id: 'sameas', pillar: 'entity', title: 'Profilurile oficiale sunt legate (sameAs + linkuri în site)', weight: 2,
    run: (c) => {
      const b = bizNode(c);
      const sameAs = b?.node.sameAs ? ([] as unknown[]).concat(b.node.sameAs as unknown[]) : [];
      const social = new Set(pagesOk(c).flatMap((p) => p.parsed.links.map((l) => l.href)).filter((h) => /(facebook|instagram|tiktok|linkedin|youtube|tripadvisor|google\.[a-z.]+\/maps|maps\.app\.goo|g\.page|foursquare|glovo|tazz|bolt\.eu)/i.test(h)));
      if (sameAs.length >= 2) return { status: 'pass', detail: `${sameAs.length} profiluri în sameAs.` };
      if (social.size) return { status: 'warn', detail: `Site-ul are linkuri spre ${social.size} profiluri, dar schema nu le declară în sameAs.`, evidence: [...social].slice(0, 6) };
      return { status: 'fail', detail: 'Nu există legături către profilurile oficiale.' };
    },
  },
  {
    id: 'nap_consistent', pillar: 'entity', title: 'Nume, adresă și telefon consistente (site ↔ schema ↔ setul de adevăr)', weight: 4,
    run: (c) => {
      const f = c.project.facts;
      if (!f.phone && !f.address) return LOCAL.has(c.project.vertical) ? { status: 'warn', detail: 'Completați telefonul și adresa în Setări → Setul de adevăr ca să putem verifica NAP.' } : { status: 'na', detail: 'Fără telefon/adresă în setul de adevăr; verificarea NAP e opțională pentru business-uri non-locale.' };
      const text = allText(c);
      const issues: string[] = [];
      const b = bizNode(c);
      if (f.phone) {
        const want = phoneKey(f.phone);
        const phones = [...new Set([...(text.match(/(\+?4?0[\s.-]?\d{2,3}[\s.-]?\d{3}[\s.-]?\d{3,4})/g) ?? []), ...pagesOk(c).flatMap((p) => p.parsed.telLinks)].map(phoneKey))].filter((p) => p.length === 9);
        if (!phones.includes(want)) issues.push(`Telefonul ${f.phone} nu apare pe site.`);
        const other = phones.filter((p) => p !== want);
        if (other.length) issues.push(`Alte numere găsite: ${other.slice(0, 3).join(', ')} (verificați dacă sunt corecte).`);
        if (b && typeof b.node.telephone === 'string' && phoneKey(b.node.telephone) !== want) issues.push(`Schema are alt telefon: ${b.node.telephone}.`);
      }
      if (f.address) {
        const streetToken = normalize(f.address).split(/[,\s]+/).filter((w) => w.length > 3 && !/^(str|strada|nr|bulevardul|bd|bdul)$/.test(w))[0];
        if (streetToken && !normalize(text).includes(streetToken)) issues.push(`Adresa (${f.address}) nu apare în textul site-ului.`);
      }
      if (!issues.length) return { status: 'pass', detail: 'NAP consistent pe paginile analizate.' };
      return { status: issues.length > 1 ? 'fail' : 'warn', detail: issues.join(' ') };
    },
  },
  {
    id: 'address_visible', pillar: 'entity', title: 'Adresa și zona deservită sunt vizibile în text', weight: 2,
    applies: (c) => LOCAL.has(c.project.vertical),
    run: (c) => {
      const t = normalize(allText(c));
      const city = c.project.city ? normalize(c.project.city) : '';
      const hasAddr = /\b(str\.?|strada|bd\.?|bulevardul|calea|sos\.?|soseaua|piata)\s+[a-z]/.test(t);
      const hoods = c.project.neighborhoods.filter((n) => t.includes(normalize(n)));
      if (hasAddr && (!city || t.includes(city))) return { status: hoods.length || !c.project.neighborhoods.length ? 'pass' : 'warn', detail: `Adresă găsită${city ? ` și orașul ${c.project.city}` : ''}. Cartiere menționate: ${hoods.join(', ') || 'niciunul'}.` };
      return { status: 'fail', detail: 'Nu se găsește o adresă clară în textul paginilor.' };
    },
  },
  {
    id: 'about_page', pillar: 'entity', title: 'Pagină „Despre” cu fapte verificabile', weight: 3,
    run: (c) => {
      const p = findPage(c, /(despre|about|povestea|cine suntem|echipa)/i);
      if (!p) return { status: 'fail', detail: 'Nu există pagină „Despre noi”.' };
      const facts = (p.parsed.text.match(/\b(19|20)\d{2}\b|\d+\s?(ani|locuri|clienti|clienți|angajati|angajați|km|%)/gi) ?? []).length;
      return { status: facts >= 2 && p.parsed.words > 150 ? 'pass' : 'warn', detail: `${p.url}: ${p.parsed.words} cuvinte, ${facts} fapte numerice (an înființare, locuri, clienți...).` };
    },
  },

  // ───────────── C. Conținut answer-ready (25)
  {
    id: 'titles_meta', pillar: 'content', title: 'Title și meta description spun clar ce oferiți', weight: 3,
    run: (c) => {
      const h = c.crawl.home;
      if (!h) return { status: 'fail', detail: '—' };
      const t = normalize(h.parsed.title + ' ' + h.parsed.metaDescription);
      const missingMeta = pagesOk(c).filter((p) => !p.parsed.metaDescription).length;
      const local = LOCAL.has(c.project.vertical);
      const city = local && c.project.city ? t.includes(normalize(c.project.city)) : true;
      // Title-ul trebuie să spună CE oferă business-ul (categorie / topic), nu doar sloganul.
      const terms = [c.project.category ?? '', ...c.project.services, ...(c.project.topics ?? []).map((x) => x.name)].flatMap((x) => normalize(x).split(/[\s,/]+/)).filter((w) => w.length > 3);
      const saysWhat = !terms.length || terms.some((w) => t.includes(w.slice(0, Math.max(4, w.length - 2))));
      if (!h.parsed.title) return { status: 'fail', detail: 'Pagina principală nu are <title>.' };
      const issues = [!saysWhat ? 'Title/description nu spun ce oferiți (categorie sau produse principale).' : '', !city ? 'Orașul nu apare în title/description.' : '', missingMeta ? `${missingMeta} din ${pagesOk(c).length} pagini fără meta description.` : ''].filter(Boolean);
      if (issues.length) return { status: !saysWhat || missingMeta > pagesOk(c).length / 2 ? 'warn' : 'pass', detail: `Title: „${h.parsed.title}”. ${issues.join(' ')}` };
      return { status: 'pass', detail: `Title: „${h.parsed.title}”.` };
    },
  },
  {
    id: 'h1', pillar: 'content', title: 'Un H1 clar pe fiecare pagină', weight: 2,
    run: (c) => {
      const bad = pagesOk(c).filter((p) => p.parsed.h1.length !== 1);
      if (!bad.length) return { status: 'pass', detail: 'Toate paginile au exact un H1.' };
      return { status: bad.length > pagesOk(c).length / 2 ? 'fail' : 'warn', detail: `${bad.length} pagini fără H1 sau cu mai multe H1.`, evidence: bad.map((p) => `${p.url} (${p.parsed.h1.length})`).slice(0, 5) };
    },
  },
  {
    id: 'service_pages', pillar: 'content', title: 'Pagini dedicate pentru fiecare serviciu / caz de utilizare', weight: 5,
    run: (c) => {
      const svc = [...new Set([...c.project.services, ...(c.project.topics ?? []).map((t) => t.name)].filter(Boolean))].slice(0, 12);
      if (!svc.length) return { status: 'warn', detail: 'Adăugați serviciile/produsele principale în proiect.' };
      const covered = svc.filter((s) => {
        const k = normalize(s).split(/\s+/).filter((w) => w.length > 3);
        return pagesOk(c).some((p) => {
          const head = normalize(p.parsed.title + ' ' + p.parsed.h1.join(' ') + ' ' + p.url);
          return k.length && k.every((w) => head.includes(w.slice(0, Math.max(4, w.length - 2))));
        });
      });
      const missing = svc.filter((s) => !covered.includes(s));
      if (!missing.length) return { status: 'pass', detail: svc.length === 1 ? 'Serviciul principal are pagină dedicată.' : `Toate cele ${svc.length} servicii/topicuri au pagină dedicată.` };
      return { status: covered.length ? 'warn' : 'fail', detail: `Fără pagină dedicată: ${missing.join(', ')}.` };
    },
  },
  {
    id: 'faq', pillar: 'content', title: 'Întrebări reale cu răspuns direct (FAQ / titluri-întrebare)', weight: 4,
    run: (c) => {
      const qs = pagesOk(c).flatMap((p) => p.parsed.questionHeadings);
      const faqSchema = pagesOk(c).some((p) => p.parsed.schemaTypes.includes('FAQPage'));
      if (qs.length >= 5) return { status: 'pass', detail: `${qs.length} întrebări formulate ca titluri${faqSchema ? ' + schema FAQPage' : ''}.`, evidence: qs.slice(0, 5) };
      if (qs.length) return { status: 'warn', detail: `Doar ${qs.length} întrebări.`, evidence: qs };
      return { status: 'fail', detail: 'Nicio întrebare formulată ca titlu — AI-ul extrage mai ușor răspunsuri la întrebări explicite.' };
    },
  },
  {
    id: 'menu_prices_text', pillar: 'content', title: 'Prețurile și oferta sunt text HTML (nu doar PDF, poză sau JavaScript)', weight: 4,
    applies: (c) => c.project.vertical !== 'b2b',
    run: (c) => {
      const p = findPage(c, c.project.vertical === 'restaurant' ? /(meniu|menu)/i : /(pret|preț|tarif|pricing|price|oferta)/i);
      const prices = (allText(c).match(/\d+([.,]\d{1,2})?\s?(lei|ron|€|eur)\b/gi) ?? []).length;
      const pdfMenu = pagesOk(c).some((pg) => pg.parsed.links.some((l) => /\.pdf/i.test(l.href) && /(meniu|menu|pret|preț)/i.test(l.href + l.text)));
      if (prices >= 8) return { status: 'pass', detail: `${prices} prețuri găsite ca text${p ? ` (pagina ${p.url})` : ''}.` };
      if (pdfMenu) return { status: 'fail', detail: 'Meniul/prețurile par să fie doar în PDF — greu de citit pentru AI.' };
      return { status: prices ? 'warn' : 'fail', detail: prices ? `Doar ${prices} prețuri ca text.` : 'Nu s-au găsit prețuri ca text pe site.' };
    },
  },
  {
    id: 'fact_density', pillar: 'content', title: 'Fapte și cifre citabile (statistici, ani, cantități)', weight: 3,
    run: (c) => {
      const t = allText(c);
      const nums = (t.match(/\b\d+([.,]\d+)?\s?(%|ani|km|minute|min|kg|grame|g|ore|h|locuri|clienți|clienti|comenzi|produse|recenzii)\b/gi) ?? []).length;
      const words = pagesOk(c).reduce((s, p) => s + p.parsed.words, 0) || 1;
      const per1k = (nums / words) * 1000;
      if (per1k >= 4) return { status: 'pass', detail: `${nums} fapte numerice (${per1k.toFixed(1)}/1000 cuvinte).` };
      return { status: per1k >= 1.5 ? 'warn' : 'fail', detail: `${nums} fapte numerice (${per1k.toFixed(1)}/1000 cuvinte). Studiul GEO (KDD 2024) arată că statisticile și citatele cresc vizibilitatea.` };
    },
  },
  {
    id: 'freshness', pillar: 'content', title: 'Semnale de actualitate (dată actualizare)', weight: 2,
    run: (c) => {
      const dated = pagesOk(c).filter((p) => p.parsed.modified || p.headers['last-modified']);
      return dated.length >= Math.max(1, pagesOk(c).length / 3)
        ? { status: 'pass', detail: `${dated.length} pagini au dată de actualizare.` }
        : { status: 'warn', detail: 'Puține pagini indică data ultimei actualizări (dateModified / „actualizat la”).' };
    },
  },
  {
    id: 'trust_signals', pillar: 'content', title: 'Dovezi: recenzii, studii de caz, autori/experți', weight: 2,
    run: (c) => {
      const t = normalize(allText(c));
      const signals = ['recenzi', 'review', 'testimonial', 'parerea clientilor', 'studiu de caz', 'case study', 'premiu', 'award', 'certificat', 'autor', 'bucatar', 'chef', 'fondator'].filter((k) => t.includes(k));
      const schemaRev = pagesOk(c).some((p) => p.parsed.schemaTypes.some((x) => /Review|AggregateRating|Person/.test(x)));
      if (signals.length >= 3 || schemaRev) return { status: 'pass', detail: `Semnale: ${signals.join(', ')}${schemaRev ? ', schema Review/Person' : ''}.` };
      return { status: signals.length ? 'warn' : 'fail', detail: signals.length ? `Semnale slabe: ${signals.join(', ')}.` : 'Nu există dovezi sociale sau autori vizibili.' };
    },
  },

  // ───────────── D. Prezență locală & surse terțe (20)
  { id: 'gbp_complete', pillar: 'offsite', title: 'Google Business Profile complet și verificat', weight: 4, manual: true, applies: (c) => LOCAL.has(c.project.vertical), run: manualCheck('Categorie principală corectă, program (inclusiv sărbători), meniu/servicii, atribute, poze recente, link comandă/rezervare. Alimentează Gemini, AI Overviews și AI Mode.') },
  { id: 'bing_places', pillar: 'offsite', title: 'Bing Places revendicat și identic cu GBP', weight: 3, manual: true, applies: (c) => LOCAL.has(c.project.vertical), run: manualCheck('ChatGPT și Copilot se sprijină pe indexul Bing; un profil Bing lipsă sau vechi te scoate din răspunsuri.') },
  { id: 'directories', pillar: 'offsite', title: 'Profiluri consistente în directoare (Apple, Facebook, Tripadvisor, Foursquare, platforme livrare)', weight: 3, manual: true, applies: (c) => LOCAL.has(c.project.vertical), run: manualCheck('Același nume, adresă, telefon, program pe toate. Modelele sunt „mașini de consens” — contradicțiile scad încrederea.') },
  { id: 'b2b_profiles', pillar: 'offsite', title: 'Profiluri pe platforme de review/comparație B2B (G2, Capterra, Clutch, LinkedIn)', weight: 4, manual: true, applies: (c) => c.project.vertical === 'b2b' || c.project.vertical === 'generic', run: manualCheck('Platformele de review și comparație sunt printre cele mai citate surse pentru prompturi comerciale B2B.') },
  { id: 'ecom_comparators', pillar: 'offsite', title: 'Prezență în comparatoare și feed-uri de produse (Google Merchant Center, compari.ro, ShopMania)', weight: 4, manual: true, applies: (c) => c.project.vertical === 'ecommerce', run: manualCheck('Comparatoarele de prețuri și feed-urile de produse sunt surse frecvente pentru întrebările de tip „de unde cumpăr X”. ChatGPT Shopping și Google folosesc feed-uri structurate.') },
  { id: 'ecom_trust', pillar: 'offsite', title: 'Profiluri de încredere pentru magazin (Trustpilot, Google Customer Reviews, ANPC/SOL vizibile)', weight: 3, manual: true, applies: (c) => c.project.vertical === 'ecommerce', run: manualCheck('Întrebările „magazin de încredere” se bazează pe recenzii terțe și pe politici clare de livrare/retur.') },
  {
    id: 'cited_sources_presence', pillar: 'offsite', title: 'Brandul apare pe sursele terțe pe care le citează AI-ul', weight: 5,
    run: (c) => {
      const t = c.tracking;
      if (!t || !t.topThirdParty) return { status: 'na', detail: 'Rulați tracking-ul ca să vedem ce surse citează AI-ul.' };
      const r = t.topThirdPartyWithOwn / t.topThirdParty;
      return { status: r >= 0.5 ? 'pass' : r >= 0.2 ? 'warn' : 'fail', detail: `Prezent în ${t.topThirdPartyWithOwn} din ${t.topThirdParty} surse terțe frecvent citate (${pct(r)}). Vezi tab-ul Surse → gap.` };
    },
  },
  { id: 'reviews', pillar: 'offsite', title: 'Recenzii autentice: volum constant, recente, cu răspuns', weight: 3, manual: true, run: manualCheck('Recenziile recente și descriptive sunt semnale cheie pentru recomandările AI. Fără recenzii cumpărate.') },
  { id: 'press_mentions', pillar: 'offsite', title: 'Mențiuni în presă, ghiduri și liste „top” citate de AI', weight: 2, manual: true, run: manualCheck('Un articol într-o publicație citată de AI valorează mai mult decât multe postări proprii. Tab-ul Surse arată exact care publicații sunt citate.') },

  // ───────────── E. Vizibilitate AI & măsurare (15)
  {
    id: 'baseline_engines', pillar: 'visibility', title: 'Baseline rulat pe minimum 3 motoare AI', weight: 3,
    run: (c) => {
      const t = c.tracking;
      if (!t || !t.n) return { status: 'fail', detail: 'Nu există încă rulări de prompturi.' };
      return { status: t.enginesRun >= 3 ? 'pass' : 'warn', detail: `${t.n} răspunsuri valide pe ${t.enginesRun} motoare.` };
    },
  },
  {
    id: 'visibility_rate', pillar: 'visibility', title: 'Rata de vizibilitate pe prompturile comerciale', weight: 5,
    run: (c) => {
      const t = c.tracking;
      if (!t || !t.n) return { status: 'na', detail: 'Rulați tracking-ul.' };
      return { status: t.visibility >= 0.4 ? 'pass' : t.visibility >= 0.15 ? 'warn' : 'fail', detail: `Brandul apare în ${pct(t.visibility)} din răspunsuri (n=${t.n}).` };
    },
  },
  {
    id: 'citation_rate', pillar: 'visibility', title: 'Site-ul propriu este citat ca sursă', weight: 3,
    run: (c) => {
      const t = c.tracking;
      if (!t || !t.n) return { status: 'na', detail: 'Rulați tracking-ul.' };
      return { status: t.citationRate >= 0.2 ? 'pass' : t.citationRate > 0 ? 'warn' : 'fail', detail: `Domeniul propriu e citat în ${pct(t.citationRate)} din răspunsuri.` };
    },
  },
  {
    id: 'ai_accuracy', pillar: 'visibility', title: 'AI-ul redă corect datele business-ului', weight: 2,
    run: (c) => {
      const t = c.tracking;
      if (!t || !t.n) return { status: 'na', detail: 'Rulați tracking-ul.' };
      return t.accuracyIssues ? { status: 'fail', detail: `${t.accuracyIssues} răspunsuri cu date greșite (telefon/adresă). Vezi Prompt Lab.` } : { status: 'pass', detail: 'Nu s-au detectat date greșite.' };
    },
  },
  { id: 'ga4_ai_channel', pillar: 'visibility', title: 'GA4: canal „AI Traffic” + evenimente de conversie', weight: 2, manual: true, run: manualCheck('Grup de canale personalizat cu regex pe sursele AI, plasat deasupra „Referral”, plus evenimentele de conversie relevante (achiziție, lead, apel).') },
  {
    id: 'llms_txt', pillar: 'visibility', title: 'llms.txt (opțional, impact neconfirmat)', weight: 0,
    run: (c) => ({ status: c.crawl.llmsTxt ? 'pass' : 'warn', detail: c.crawl.llmsTxt ? 'Există llms.txt.' : 'Nu există llms.txt. Cost mic, dar nu e prioritar — datele publice arată că rar e accesat de crawlere.' }),
  },
];

/** Crește la fiecare schimbare de reguli/texte; auditurile mai vechi sunt refăcute automat. */
export const AUDIT_VERSION = 3;

function homeStatusHint(status: number): string {
  if ([403, 429, 503, 511].includes(status)) return ' — site-ul a respins crawlerul (protecție anti-bot / limită de cereri de la IP-ul dvs.), nu neapărat vizitatorii sau boții reali';
  if (status >= 500) return ' — eroare de server';
  return '';
}

export function runAudit(ctx: AuditContext): AuditResult {
  const startedAt = new Date().toISOString();
  const findings: Finding[] = [];
  const hf = ctx.crawl.homeFetch;
  // Pagina principală n-a putut fi citită → verificările de conținut ar ieși toate „picate” fals. Le marcăm „nu s-a putut verifica”.
  const unreadable = !hf.status || hf.status >= 400 ? { status: hf.status, reason: hf.status ? `HTTP ${hf.status}${homeStatusHint(hf.status)}` : hf.error ?? 'fără răspuns' } : undefined;
  for (const ch of CHECKS) {
    if (ch.applies && !ch.applies(ctx)) continue;
    let ev: Eval;
    try {
      ev = unreadable && !ch.manual && ch.id !== 'home_https_200' && ['access', 'entity', 'content'].includes(ch.pillar)
        ? { status: 'na', detail: `Nu s-a putut verifica: site-ul nu a putut fi citit (${unreadable.reason}).` }
        : ch.run(ctx);
    } catch (e) {
      ev = { status: 'warn', detail: `Eroare la verificare: ${(e as Error).message}` };
    }
    if (ch.manual && ctx.manualDone.has(ch.id)) ev = { status: 'pass', detail: 'Bifat manual ca rezolvat.', evidence: ev.evidence };
    findings.push({ id: ch.id, pillar: ch.pillar, title: ch.title, weight: ch.weight, status: ev.status, detail: ev.detail, evidence: ev.evidence ?? [], manual: ch.manual });
  }
  const { score, pillarScores } = scoreFindings(findings);
  return {
    url: ctx.crawl.origin,
    startedAt,
    finishedAt: new Date().toISOString(),
    version: AUDIT_VERSION,
    unreadable,
    pagesCrawled: ctx.crawl.pages.length,
    score,
    pillarScores,
    findings,
    pages: ctx.crawl.pages.map((p) => ({ url: p.url, status: p.status, title: p.parsed.title, h1: p.parsed.h1, words: p.parsed.words, schemaTypes: p.parsed.schemaTypes, noindex: p.noindex, jsOnly: p.jsOnly, ms: p.ms })),
    bots: ctx.crawl.bots,
    notes: ctx.crawl.notes,
  };
}

/** Scor /100: pass = 100%, warn = 50%, fail/manual nebifat = 0; „na” se exclude și se renormalizează. */
export function scoreFindings(findings: Finding[]): { score: number; pillarScores: Record<Pillar, { score: number; max: number }> } {
  const pillars: Pillar[] = ['access', 'entity', 'content', 'offsite', 'visibility'];
  const pillarScores = {} as Record<Pillar, { score: number; max: number }>;
  let got = 0;
  let max = 0;
  for (const p of pillars) {
    let g = 0;
    let m = 0;
    for (const f of findings.filter((x) => x.pillar === p && x.status !== 'na' && x.weight > 0)) {
      m += f.weight;
      g += f.status === 'pass' ? f.weight : f.status === 'warn' ? f.weight / 2 : 0;
    }
    pillarScores[p] = { score: Math.round(g * 10) / 10, max: m };
    got += g;
    max += m;
  }
  return { score: max ? Math.round((got / max) * 100) : 0, pillarScores };
}

/** Recalculează scorul după bifări manuale, fără re-crawl. */
export function applyManual(audit: AuditResult, manualDone: Set<string>): AuditResult {
  const findings = audit.findings.map((f) =>
    f.manual ? { ...f, status: (manualDone.has(f.id) ? 'pass' : 'manual') as CheckStatus, detail: manualDone.has(f.id) ? 'Bifat manual ca rezolvat.' : f.status === 'pass' ? '' : f.detail } : f,
  );
  for (const f of findings) if (f.manual && !manualDone.has(f.id) && !f.detail) f.detail = CHECKS.find((c) => c.id === f.id)?.run({} as AuditContext).detail ?? '';
  return { ...audit, findings, ...scoreFindings(findings) };
}

export const CHECK_IDS = CHECKS.map((c) => c.id);

/** Verificările care depind doar de tracking (se recalculează la fiecare citire, fără re-crawl). */
const DYNAMIC = new Set(['cited_sources_presence', 'baseline_engines', 'visibility_rate', 'citation_rate', 'ai_accuracy']);

/** Auditul „live”: verificările de crawl din ultimul audit + tracking-ul curent + bifele manuale. */
export function liveAudit(audit: AuditResult, project: Project, tracking: TrackingSummary | undefined, manualDone: Set<string>): AuditResult {
  const ctx = { project, crawl: {} as CrawlData, tracking, manualDone };
  const findings = audit.findings.map((f) => {
    if (!DYNAMIC.has(f.id)) return f;
    const ch = CHECKS.find((c) => c.id === f.id)!;
    const ev = ch.run(ctx);
    return { ...f, status: ev.status, detail: ev.detail, evidence: ev.evidence ?? [] };
  });
  return applyManual({ ...audit, findings }, manualDone);
}
