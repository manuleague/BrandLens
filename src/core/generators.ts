// Butoanele „Generează”: artefacte gata de implementat. Câmpurile necunoscute sunt marcate [COMPLETAȚI]
// — nu inventăm fapte (prețuri, alergeni, program) pe care clientul nu le-a confirmat.

import { AI_REFERRER_REGEX, BOTS } from './bots.ts';
import type { MetricsReport } from './metrics.ts';
import type { SourceRow } from './sources.ts';
import type { GeneratorKind, Project, PromptDef } from './types.ts';

export interface Generated {
  title: string;
  format: 'json' | 'text' | 'html' | 'markdown';
  content: string;
  notes: string[];
}

const TODO = '[COMPLETAȚI]';

function schemaType(p: Project): string {
  if (p.vertical === 'restaurant') return 'Restaurant';
  if (p.vertical === 'local_service') return 'LocalBusiness';
  if (p.vertical === 'ecommerce') return 'OnlineStore';
  return 'Organization';
}

function parseHours(h?: string): unknown[] | undefined {
  // Acceptă „Mo-Su 11:00-23:00; Fr-Sa 11:00-01:00”
  if (!h) return undefined;
  const map: Record<string, string> = { mo: 'Monday', tu: 'Tuesday', we: 'Wednesday', th: 'Thursday', fr: 'Friday', sa: 'Saturday', su: 'Sunday' };
  const days = Object.keys(map);
  const out: unknown[] = [];
  for (const part of h.split(/[;,]\s*/)) {
    const m = part.trim().match(/^([A-Za-z]{2})(?:-([A-Za-z]{2}))?\s+(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/);
    if (!m) continue;
    const a = days.indexOf(m[1].toLowerCase());
    const b = m[2] ? days.indexOf(m[2].toLowerCase()) : a;
    if (a < 0 || b < 0) continue;
    const ds: string[] = [];
    for (let i = a; ; i = (i + 1) % 7) {
      ds.push(map[days[i]]);
      if (i === b) break;
    }
    out.push({ '@type': 'OpeningHoursSpecification', dayOfWeek: ds, opens: m[3], closes: m[4] });
  }
  return out.length ? out : undefined;
}

export function genSchema(p: Project): Generated {
  const f = p.facts;
  const url = `https://${p.domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/`;
  const node: Record<string, unknown> = {
    '@context': 'https://schema.org',
    '@type': schemaType(p),
    '@id': `${url}#business`,
    name: p.name,
    url,
    description: f.description ?? TODO,
    image: `${url}${TODO}-fotografie-locatie.jpg`,
    logo: `${url}${TODO}-logo.png`,
    telephone: f.phone ?? TODO,
    email: f.email,
    sameAs: f.profiles?.length ? f.profiles : [TODO + ' URL Google Business Profile', TODO + ' URL Facebook', TODO + ' URL Instagram'],
  };
  if (p.vertical === 'restaurant' || p.vertical === 'local_service') {
    node.address = { '@type': 'PostalAddress', streetAddress: f.address ?? TODO, addressLocality: f.city ?? p.city ?? TODO, postalCode: f.postalCode ?? TODO, addressCountry: p.country };
    node.geo = f.lat !== undefined ? { '@type': 'GeoCoordinates', latitude: f.lat, longitude: f.lng } : { '@type': 'GeoCoordinates', latitude: TODO, longitude: TODO };
    node.openingHoursSpecification = parseHours(f.hours) ?? TODO + ' ex: Mo-Su 11:00-23:00 în Setări';
    node.priceRange = f.priceRange ?? TODO;
    if (p.neighborhoods.length) node.areaServed = p.neighborhoods.map((n) => ({ '@type': 'Place', name: `${n}, ${p.city ?? ''}`.trim() }));
  }
  if (p.vertical === 'restaurant') {
    node.servesCuisine = f.cuisine ? f.cuisine.split(/,\s*/) : [TODO];
    node.hasMenu = f.menuUrl ?? `${url}meniu`;
    node.acceptsReservations = TODO + ' true/false';
    if (f.orderUrl) node.potentialAction = { '@type': 'OrderAction', target: f.orderUrl };
  }
  if (f.foundedYear) node.foundingDate = f.foundedYear;
  Object.keys(node).forEach((k) => node[k] === undefined && delete node[k]);
  const json = JSON.stringify(node, null, 2);
  return {
    title: `JSON-LD ${schemaType(p)}`,
    format: 'html',
    content: `<script type="application/ld+json">\n${json}\n</script>`,
    notes: [
      'Inserați în <head> pe pagina principală (și pe pagina de contact).',
      `Înlocuiți toate valorile ${TODO} cu date reale — schema trebuie să fie identică cu informația vizibilă pe pagină.`,
      'Validați în search.google.com/test/rich-results și validator.schema.org.',
      'Schema clarifică semantica; nu garantează afișarea sau citarea.',
    ],
  };
}

export function genRobots(p: Project, existing?: string): Generated {
  const search = BOTS.filter((b) => b.purpose === 'search' || b.purpose === 'user');
  const training = BOTS.filter((b) => b.purpose === 'training');
  const lines = [
    '# robots.txt generat de BrandLens — verificați înainte de publicare',
    '# 1) Boți de căutare și de răspuns AI: PERMIȘI (necesari pentru a apărea și a fi citat)',
    ...search.flatMap((b) => [`User-agent: ${b.token}`, 'Allow: /', '']),
    '# 2) Boți de antrenare: DECIZIE DE BUSINESS. Implicit permiși; pentru a refuza antrenarea,',
    '#    înlocuiți „Allow: /” cu „Disallow: /” — NU afectează apariția în căutare.',
    ...training.flatMap((b) => [`User-agent: ${b.token}`, 'Allow: /', '']),
    '# 3) Restul',
    'User-agent: *',
    'Disallow: /wp-admin/',
    'Allow: /wp-admin/admin-ajax.php',
    'Disallow: /cos/',
    'Disallow: /checkout/',
    '',
    `Sitemap: https://${p.domain.replace(/^https?:\/\//, '').replace(/\/$/, '')}/sitemap.xml`,
  ];
  return {
    title: 'robots.txt recomandat',
    format: 'text',
    content: lines.join('\n'),
    notes: [
      'Ajustați regulile „Disallow” din secțiunea 3 la structura site-ului (exemplele sunt pentru WordPress/WooCommerce).',
      'Verificați și CDN/WAF (ex. Cloudflare → Security → Bots / AI Crawl Control): robots.txt nu ajută dacă firewall-ul blochează boții.',
      'OpenAI: schimbările din robots.txt pentru căutare se reflectă în ~24h.',
      ...(existing ? ['Fișierul actual a fost păstrat în audit (tab Audit → Acces boți) pentru comparație.'] : []),
    ],
  };
}

export function genFaq(p: Project, prompts: PromptDef[]): Generated {
  const f = p.facts;
  const city = p.city ?? '';
  const qa: [string, string][] = [];
  const add = (q: string, a: string) => qa.length < 12 && !qa.some(([x]) => x === q) && qa.push([q, a]);
  add(`Unde se află ${p.name}?`, f.address ? `${p.name} se află la ${f.address}${city ? `, ${city}` : ''}.${p.neighborhoods.length ? ` Livrăm în: ${p.neighborhoods.join(', ')}.` : ''}` : TODO);
  add(`Care este programul ${p.name}?`, f.hours ? `Program: ${f.hours}. ${TODO} program de livrare dacă diferă.` : TODO);
  add(`Cât costă ${p.services[0] ?? 'un produs'} la ${p.name}?`, f.priceRange ? `Prețurile sunt între ${f.priceRange}. Meniul complet cu prețuri: ${f.menuUrl ?? TODO}.` : TODO);
  if (p.vertical === 'restaurant') {
    add(`Aveți opțiuni vegetariene, vegane sau fără gluten?`, TODO + ' (listați preparatele exacte și alergenii)');
    add(`Faceți livrare în ${city}? În ce zone și în cât timp?`, TODO + ' (zone, timp mediu, cost livrare, comandă minimă)');
    add(`Se poate rezerva pentru un grup mare?`, TODO + ' (capacitate, cum se rezervă, până la ce oră)');
    add(`Aveți parcare și acces pentru cărucioare/scaune cu rotile?`, TODO);
  }
  for (const pr of prompts.filter((x) => x.active && x.intent !== 'brand' && x.lang === 'ro')) {
    const q = pr.text.replace(/^Recomandă-mi\s+\d+\s+/i, '').replace(/\.$/, '');
    add(q.endsWith('?') ? q : `${q}?`, `${TODO} — răspuns direct în 1-2 fraze, cu un fapt verificabil despre ${p.name}.`);
  }
  const html = qa.map(([q, a]) => `<h3>${q}</h3>\n<p>${a}</p>`).join('\n\n');
  const schema = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: qa.map(([q, a]) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } })),
  };
  return {
    title: 'FAQ answer-ready (HTML + schema FAQPage)',
    format: 'html',
    content: `<section id="intrebari-frecvente">\n<h2>Întrebări frecvente</h2>\n\n${html}\n</section>\n\n<script type="application/ld+json">\n${JSON.stringify(schema, null, 2)}\n</script>`,
    notes: [`Completați fiecare ${TODO} cu informații reale; ștergeți întrebările care nu se aplică.`, 'Răspunsul direct în prima frază, apoi detalii. Fără promisiuni neverificabile.', 'Schema FAQPage trebuie să conțină exact textul vizibil.'],
  };
}

export function genBrief(p: Project, target: string, metrics?: MetricsReport | null, sources?: SourceRow[]): Generated {
  const pr = metrics?.prompts.find((x) => x.promptId === target);
  const topic = pr?.text ?? target ?? p.services[0] ?? p.name;
  const winners = pr?.winners.map((w) => w.brand).slice(0, 4) ?? [];
  const cited = (sources ?? []).filter((s) => s.type !== 'owned').slice(0, 6).map((s) => s.domain);
  const md = `# Brief de conținut answer-ready

**Prompt țintă:** ${topic}
**Brand:** ${p.name} (${p.domain})${p.city ? ` · ${p.city}` : ''}
**Pe cine recomandă AI-ul acum:** ${winners.join(', ') || '—'}
**Surse citate frecvent în categorie:** ${cited.join(', ') || '—'}

## Structură recomandată
1. **H1** formulat ca întrebarea reală: „${topic.replace(/\?$/, '')}?”
2. **Răspuns direct în primele 2-3 fraze** (max. 60 de cuvinte): cine, ce, unde, cât costă, de ce ${p.name}.
3. **Fapte verificabile** (minimum 5): prețuri / intervale, timp de livrare, ingrediente sau metodă, ani de experiență, capacitate, zone deservite.
4. **Comparație onestă**: criterii după care să alegi (preț, timp, calitate, acces) — fără a denigra competitorii.
5. **FAQ** cu 4-6 întrebări reale legate de prompt.
6. **Dovezi**: 2-3 recenzii reale cu link la sursă, fotografii proprii.
7. **Date practice**: adresă, program, telefon, link comandă/rezervare — identice cu GBP.
8. **„Actualizat la [dată]”** vizibil.

## Reguli
- Text în HTML (nu imagine/PDF), un singur H1, URL scurt și descriptiv.
- Schema potrivită (${schemaType(p)} / FAQPage) doar dacă reflectă conținutul vizibil.
- Legați pagina din meniu și din pagina principală.
- Nu inventați cifre; fiecare afirmație comercială trebuie să poată fi verificată.

## Criteriu de acceptare
Pagina e indexată, iar la următoarele 2 rulări ${p.name} apare pentru acest prompt în cel puțin un motor.`;
  return { title: `Brief: ${topic}`, format: 'markdown', content: md, notes: ['Trimiteți brief-ul echipei de conținut sau folosiți-l ca prompt pentru un draft pe care îl verificați factual.'] };
}

export function genOutreach(p: Project, domain?: string, sources?: SourceRow[]): Generated {
  const s = sources?.find((x) => x.domain === domain);
  const url = s?.urls[0]?.url ?? `https://${domain ?? TODO}`;
  const body = `Subiect: Informații actualizate despre ${p.name} pentru articolul dvs.

Bună ziua,

Am citit articolul dvs. „${s?.urls[0]?.title ?? TODO + ' titlul articolului'}” (${url}) și ne-a plăcut cum ați prezentat opțiunile din ${p.city ?? TODO}.

Sunt ${TODO} de la ${p.name}${p.city ? ` (${p.city})` : ''}. Vă scriu pentru că ${TODO + ' — un motiv concret: lansare, specialitate, un fapt nou'}.

Câteva lucruri verificabile, dacă vă sunt utile:
• ${TODO + ' fapt verificabil 1 (o cifră proprie: ani, clienți, timp de livrare)'}
• ${TODO + ' fapt verificabil 2 (ce vă diferențiază concret)'}
• ${TODO + ' fapt verificabil 3 (rating și număr de recenzii, cu sursa)'}

Vă putem trimite materiale, date sau acces de test, fără nicio obligație de a ne include.

Mulțumesc,
${TODO + ' nume'}
${p.name} · ${p.facts.phone ?? TODO} · https://${p.domain}`;
  return {
    title: `Email de outreach${domain ? ` — ${domain}` : ''}`,
    format: 'text',
    content: body,
    notes: ['Personalizați fiecare email; nu trimiteți în masă.', 'Nu oferiți plată pentru includere fără marcarea clară ca publicitate.', 'Urmăriți răspunsul ca acțiune în backlog.'],
  };
}

export function genGa4(): Generated {
  return {
    title: 'GA4 — canal „AI Traffic” + evenimente',
    format: 'markdown',
    content: `## 1. Grup de canale personalizat
GA4 → Admin → Data display → **Channel groups** → Create new channel group (copie a celui implicit)

- **Nume canal:** AI Traffic
- **Condiție:** Session source **matches regex**:
\`\`\`
${AI_REFERRER_REGEX}
\`\`\`
- **Mutați canalul DEASUPRA „Referral”** (GA4 evaluează regulile de sus în jos).
- Salvați și folosiți grupul în rapoartele Traffic acquisition.

## 2. Evenimente de conversie (business local)
| Eveniment | Declanșare |
|---|---|
| click_to_call | click pe linkuri \`tel:\` |
| get_directions | click pe link Google Maps / Waze |
| order_online | click pe „Comandă” (site sau Glovo/Tazz/Bolt) |
| reservation | trimitere formular rezervare |

Marcați-le ca **Key events**.

## 3. Formulare și CRM
- Câmp ascuns „sursa” care păstrează utm_source / referrer la prima vizită.
- Întrebarea „Cum ne-ați găsit?” cu opțiunea **ChatGPT / Gemini / alt asistent AI**.

## Limite
- Recomandările AI fără click nu apar în GA4.
- AI Overviews / AI Mode apar ca Organic Search; o parte din sesiunile AI ajung în Direct.
- Revizuiți regex-ul trimestrial.`,
    notes: ['GA4 are și un canal implicit pentru asistenți AI în versiunile recente; grupul personalizat acoperă și sursele pe care nu le prinde.'],
  };
}

export function genNap(p: Project): Generated {
  const f = p.facts;
  const local = p.vertical === 'restaurant' || p.vertical === 'local_service';
  const profiles = local
    ? ['Site (footer + contact + schema)', 'Google Business Profile', 'Bing Places', 'Apple Business Connect', 'Facebook', 'Instagram', 'Tripadvisor', 'Foursquare', 'Waze', ...(p.vertical === 'restaurant' ? ['Glovo', 'Tazz', 'Bolt Food', 'Restaurant Guru'] : ['Pagini Aurii', 'Cylex'])]
    : ['Site (footer + contact + schema)', 'LinkedIn Company', 'Google Business Profile', 'Crunchbase', 'G2 / Capterra', 'Trustpilot', 'Facebook'];
  const rows = profiles.map((x) => `| ${x} | ☐ | ☐ | ☐ | ☐ | |`).join('\n');
  return {
    title: 'Fișa NAP — reconciliere profiluri',
    format: 'markdown',
    content: `## Forma oficială (setul de adevăr)
- **Nume:** ${p.name}
- **Adresă:** ${f.address ?? TODO}${p.city ? `, ${p.city}` : ''}
- **Telefon:** ${f.phone ?? TODO}
- **Program:** ${f.hours ?? TODO}
- **Site:** https://${p.domain}
- **Categorie principală:** ${TODO}

## Verificare pe profiluri
| Profil | Nume | Adresă | Telefon | Program | URL profil |
|---|---|---|---|---|---|
${rows}

Bifați fiecare câmp doar după ce ați verificat că este **identic** cu forma oficială. Notați URL-ul profilului ca dovadă.`,
    notes: ['Diferențele mici contează (ex. „Str.” vs „Strada”, cu/fără prefix +40) — alegeți o formă și folosiți-o peste tot.'],
  };
}

export function genReviews(p: Project): Generated {
  return {
    title: 'Plan de recenzii autentice',
    format: 'markdown',
    content: `## Canale de invitare (fără stimulente interzise)
1. **Invitație după comandă / serviciu** (QR pe ambalaj sau la locație, email, SMS) → link direct la platforma de recenzii relevantă (Google, Trustpilot, platforma de nișă).
2. **Mesaj după comandă** (SMS/email, cu acordul clientului):
   > Mulțumim că ați ales ${p.name}! Dacă v-a plăcut, ne ajută mult o recenzie sinceră: [link]. Ne interesează și ce putem îmbunătăți.
3. **Personal instruit** să menționeze recenziile la final, fără presiune.

## Ce cerem
- Detalii concrete (ce ați comandat, cum a fost livrarea) — recenziile descriptive sunt mai utile pentru oameni și pentru AI.

## Răspunsuri
- Răspuns la **fiecare** recenzie în 48h, factual și politicos.
- La recenziile negative: recunoașteți, explicați ce s-a corectat, oferiți contact direct.

## Interzis
- Recenzii cumpărate, scrise de angajați sau oferite în schimbul reducerilor (încalcă politicile Google și pot duce la suspendarea profilului).

## Măsurare lunară
| Lună | Recenzii noi | Rating mediu | % răspunsuri | Teme recurente |
|---|---|---|---|---|
| | | | | |`,
    notes: [],
  };
}

export function genLlms(p: Project): Generated {
  const f = p.facts;
  return {
    title: 'llms.txt (opțional)',
    format: 'markdown',
    content: `# ${p.name}

> ${f.description ?? TODO + ' descriere factuală în 1-2 fraze'}

- Adresă: ${f.address ?? TODO}${p.city ? `, ${p.city}` : ''}
- Telefon: ${f.phone ?? TODO}
- Program: ${f.hours ?? TODO}

## Pagini principale
- [Meniu / Servicii](https://${p.domain}/${TODO})
- [Despre](https://${p.domain}/despre)
- [Contact](https://${p.domain}/contact)
- [Întrebări frecvente](https://${p.domain}/${TODO})`,
    notes: ['Impact neconfirmat: datele publice arată că rar e descărcat de crawlerele AI. Faceți-l ultimul.'],
  };
}

export function generate(kind: GeneratorKind, p: Project, ctx: { prompts: PromptDef[]; metrics?: MetricsReport | null; sources?: SourceRow[]; arg?: string }): Generated {
  switch (kind) {
    case 'schema': return genSchema(p);
    case 'robots': return genRobots(p);
    case 'faq': return genFaq(p, ctx.prompts);
    case 'brief': return genBrief(p, ctx.arg ?? '', ctx.metrics, ctx.sources);
    case 'outreach': return genOutreach(p, ctx.arg, ctx.sources);
    case 'ga4': return genGa4();
    case 'nap': return genNap(p);
    case 'reviews': return genReviews(p);
    case 'llms': return genLlms(p);
  }
}
