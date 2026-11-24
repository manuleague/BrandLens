// Motorul de recomandări: transformă constatările (audit + surse + prompturi + motoare) în acțiuni bifabile,
// fiecare cu motiv, pași exacți, criteriu de acceptare și prioritate explicabilă:
//   Prioritate = Impact (1-5) × Gap (1-5) × Încredere (1-5) ÷ Efort (1-5)

import type { MetricsReport } from './metrics.ts';
import { SOURCE_TYPE_LABEL, type SourceRow } from './sources.ts';
import type { ActionCategory, ActionItem, AuditResult, EngineId, Finding, GeneratorKind, Project } from './types.ts';

interface Tpl {
  category: ActionCategory;
  title?: string;
  why: string;
  steps: string[];
  acceptance: string;
  impact: number;
  effort: number;
  confidence: number;
  generator?: GeneratorKind;
  critical?: boolean;
}

const T: Record<string, Tpl> = {
  home_https_200: { category: 'technical', critical: true, impact: 5, effort: 2, confidence: 5, why: 'Dacă pagina principală nu răspunde corect, niciun motor AI nu o poate citi sau cita.', steps: ['Verificați hostingul / certificatul SSL.', 'Redirect 301 de la HTTP la HTTPS și de la non-www la varianta canonică.', 'Re-rulați auditul.'], acceptance: 'Pagina principală întoarce 200 pe HTTPS.' },
  robots_ai_search: { category: 'technical', critical: true, impact: 5, effort: 1, confidence: 5, generator: 'robots', why: 'Crawlerele de căutare AI (OAI-SearchBot, Claude-SearchBot, PerplexityBot) și Googlebot/Bingbot trebuie să poată citi site-ul ca să-l poată cita. Blocarea lor te scoate din răspunsuri.', steps: ['Deschideți /robots.txt și eliminați Disallow pentru boții de căutare indicați.', 'Decideți separat (decizie de business) dacă permiteți boții de antrenare (GPTBot, ClaudeBot, Google-Extended).', 'Folosiți butonul „Generează robots.txt” și publicați fișierul.', 'Re-rulați auditul după publicare.'], acceptance: 'Toți boții de căutare AI au acces la „/”.' },
  waf_bots: { category: 'technical', critical: true, impact: 5, effort: 2, confidence: 3, why: 'Multe CDN-uri/WAF (ex. Cloudflare Bot Fight Mode) blochează silențios boții AI chiar dacă robots.txt îi permite.', steps: ['În CDN/WAF, verificați regulile de bot management și „AI crawl control”.', 'Permiteți boții de căutare verificați (OAI-SearchBot, Claude-SearchBot, PerplexityBot, Bingbot, Googlebot).', 'Verificați în logurile serverului/CDN că cererile lor primesc 200.'], acceptance: 'Testul live nu mai întoarce 403/429/challenge pentru boții AI; logurile confirmă 200.' },
  sitemap: { category: 'technical', impact: 3, effort: 1, confidence: 4, why: 'Sitemap-ul ajută crawlerele să descopere rapid paginile noi (oferte, categorii, servicii, FAQ).', steps: ['Generați sitemap.xml din CMS (WordPress: Yoast/RankMath; altfel generator static).', 'Adăugați „Sitemap: https://domeniu/sitemap.xml” în robots.txt.', 'Trimiteți sitemap-ul în Google Search Console și Bing Webmaster Tools.'], acceptance: 'sitemap.xml valid, declarat în robots.txt și trimis în GSC + Bing.' },
  server_rendered: { category: 'technical', critical: true, impact: 5, effort: 4, confidence: 4, why: 'Crawlerele AI nu execută de regulă JavaScript; dacă produsele, prețurile sau datele de contact apar doar după JS, pentru AI pagina e goală.', steps: ['Activați SSR/SSG (Next.js, Nuxt, Astro) sau pre-randare pentru paginile publice.', 'Alternativ: puneți faptele esențiale (ce oferiți, prețuri, date de contact, politici) în HTML static.', 'Testați cu „curl” sau „Vezi sursa paginii” că textul apare fără JS.'], acceptance: 'Textul esențial apare în HTML-ul inițial pe toate paginile cheie.' },
  indexable: { category: 'technical', impact: 4, effort: 1, confidence: 5, why: 'O pagină cu noindex nu intră în indexul Google/Bing și, implicit, în sursele multor motoare AI.', steps: ['Eliminați meta robots noindex / header X-Robots-Tag de pe paginile publice.', 'Setați canonical absolut către URL-ul preferat.'], acceptance: 'Paginile cheie sunt indexabile, cu canonical corect.' },
  speed: { category: 'technical', impact: 2, effort: 3, confidence: 3, why: 'Paginile lente sunt crawl-uite mai rar și pot expira la fetch-ul în timp real al asistenților.', steps: ['Activați cache și compresie (Brotli/Gzip) și un CDN.', 'Optimizați imaginile (WebP/AVIF, dimensiuni corecte).', 'Reduceți scripturile terțe.'], acceptance: 'Timp mediu de răspuns < 1,2 s.' },
  schema_business: { category: 'entity', impact: 4, effort: 2, confidence: 4, generator: 'schema', why: 'Datele structurate clarifică pentru mașini cine ești, unde ești și ce oferi. Nu garantează citarea, dar elimină ambiguitatea.', steps: ['Generați JSON-LD cu butonul „Generează schema”.', 'Completați câmpurile marcate și verificați că reflectă conținutul vizibil.', 'Inserați în <head> pe pagina principală (și pe pagina de contact).', 'Validați în Rich Results Test și validator.schema.org.'], acceptance: 'Schema validă, fără erori, identică cu informația vizibilă.' },
  schema_props: { category: 'entity', impact: 3, effort: 2, confidence: 4, generator: 'schema', why: 'Proprietățile lipsă sunt exact filtrele folosite în prompturi (preț, program, livrare, contact).', steps: ['Adăugați proprietățile lipsă indicate în constatare.', 'Revalidați schema.'], acceptance: 'Schema conține toate proprietățile cheie.' },
  sameas: { category: 'entity', impact: 3, effort: 1, confidence: 3, generator: 'schema', why: 'sameAs leagă entitatea de profilurile oficiale (GBP, Facebook, Instagram, Tripadvisor), ajutând modelele să unifice informația.', steps: ['Adăugați în proiect lista profilurilor oficiale (Setări → Setul de adevăr).', 'Regenerați schema — sameAs se completează automat.', 'Puneți linkuri vizibile spre profiluri în footer.'], acceptance: 'Minimum 2 profiluri oficiale în sameAs și în footer.' },
  nap_consistent: { category: 'entity', critical: true, impact: 5, effort: 2, confidence: 4, generator: 'nap', why: 'Modelele sunt „mașini de consens”: un telefon sau o adresă diferită pe site, schema și profiluri scade încrederea și produce răspunsuri greșite.', steps: ['Stabiliți forma oficială a numelui, adresei și telefonului.', 'Corectați site-ul, schema, GBP, Bing Places, Facebook, Tripadvisor, platformele de livrare.', 'Folosiți „Fișa NAP” generată ca listă de verificare.'], acceptance: 'NAP identic pe site, schema și toate profilurile din fișă.' },
  address_visible: { category: 'entity', impact: 4, effort: 1, confidence: 4, why: 'Pentru prompturile locale („… în zona X”), AI-ul are nevoie de adresă și zone deservite explicite.', steps: ['Adăugați în footer adresa completă și orașul.', 'Pe pagina de contact: adresă, hartă, program, telefon, zonele deservite.'], acceptance: 'Adresa, orașul și zonele deservite apar ca text pe site.' },
  about_page: { category: 'content', impact: 3, effort: 2, confidence: 3, why: 'Pagina „Despre” este sursa preferată pentru descrierea entității: fapte, nu sloganuri.', steps: ['Scrieți: an înființare, fondator/echipă, număr locuri, specialitate verificabilă, distincții.', 'Adăugați fotografii proprii și datele de contact.'], acceptance: 'Pagină „Despre” > 150 cuvinte, cu minimum 3 fapte verificabile.' },
  titles_meta: { category: 'content', impact: 3, effort: 1, confidence: 4, why: 'Title și description sunt primele semnale citite de motoarele de căutare care alimentează AI-ul.', steps: ['Title-ul spune ce oferiți, nu doar sloganul: „{Ce vindeți / categoria}{ în Oraș, dacă e business local} | {Brand}”.', 'Meta description de 140-160 caractere cu oferta principală și un fapt diferențiator (livrare, retur, garanție, zonă).', 'Completați meta description pe paginile care nu o au.'], acceptance: 'Title-ul paginii principale conține categoria; toate paginile au meta description.' },
  h1: { category: 'content', impact: 2, effort: 1, confidence: 3, why: 'Un H1 clar spune exact despre ce e pagina; ajută extragerea.', steps: ['Un singur H1 per pagină, formulat ca subiectul paginii.'], acceptance: 'Fiecare pagină are exact un H1.' },
  service_pages: { category: 'content', impact: 5, effort: 3, confidence: 4, generator: 'brief', why: 'Fiecare întrebare reală a clienților are nevoie de o pagină care îi răspunde direct. Fără ea, AI-ul citează pe altcineva.', steps: ['Pentru fiecare serviciu lipsă, generați brief-ul de conținut.', 'Publicați pagina: răspuns direct în primele 2-3 fraze, fapte, prețuri, FAQ, CTA.', 'Legați pagina din meniu și din pagina principală.'], acceptance: 'Fiecare serviciu are o pagină indexabilă cu răspuns direct.' },
  faq: { category: 'content', impact: 4, effort: 2, confidence: 4, generator: 'faq', why: 'Întrebările formulate ca titluri, cu răspuns în prima frază, sunt ușor de extras și citat.', steps: ['Generați FAQ-ul din prompturile urmărite.', 'Completați răspunsurile cu fapte reale (fără promisiuni neverificabile).', 'Publicați pe pagina relevantă, cu schema FAQPage dacă e conformă.'], acceptance: 'Minimum 8 întrebări reale, cu răspuns direct, pe site.' },
  menu_prices_text: { category: 'content', critical: true, impact: 5, effort: 2, confidence: 5, why: 'Oferta în PDF, poze sau încărcată doar din JavaScript e invizibilă pentru AI. Prețurile ca text permit recomandări pe buget („sub 500 lei”).', steps: ['Publicați oferta / lista de prețuri ca HTML: denumire, descriere scurtă, preț, atribute relevante.', 'Păstrați PDF-ul doar ca alternativă.', 'Sincronizați cu profilurile externe (GBP, marketplace-uri, feed-uri).'], acceptance: 'Meniu/prețuri ca text HTML, indexabil, actualizat.' },
  fact_density: { category: 'content', impact: 3, effort: 2, confidence: 3, why: 'Studiul academic GEO (KDD 2024) a găsit cele mai mari creșteri de vizibilitate când conținutul include statistici, citate și surse.', steps: ['Adăugați cifre proprii verificabile: ani de activitate, număr de clienți/comenzi, timpi de livrare, garanții, mărimea ofertei.', 'Creați un „număr citabil” (ex. un mic studiu din datele proprii) pe care presa îl poate cita.'], acceptance: '≥ 4 fapte numerice / 1000 cuvinte pe paginile cheie.' },
  freshness: { category: 'content', impact: 2, effort: 1, confidence: 3, why: 'Motoarele cu căutare live preferă informații recente; o dată de actualizare vizibilă ajută.', steps: ['Afișați „Actualizat la [dată]” pe prețuri, ghiduri și FAQ.', 'Adăugați dateModified în schema paginilor de conținut.'], acceptance: 'Paginile cheie afișează data actualizării.' },
  trust_signals: { category: 'reputation', impact: 3, effort: 2, confidence: 3, why: 'Dovezile (recenzii, autori, premii) cresc încrederea surselor și probabilitatea recomandării.', steps: ['Afișați recenzii reale (cu link la sursă).', 'Prezentați echipa/bucătarul/experții.', 'Adăugați distincții și apariții în presă.'], acceptance: 'Minimum 3 tipuri de dovezi vizibile pe site.' },
  gbp_complete: { category: 'entity', critical: true, impact: 5, effort: 2, confidence: 5, generator: 'nap', why: 'Gemini, AI Overviews și AI Mode folosesc Google Business Profile, Maps și recenziile Google pentru recomandări locale.', steps: ['Categorie principală precisă + secundare.', 'Program corect, inclusiv sărbători; ore separate livrare vs. sală.', 'Meniu/servicii, atribute (livrare, terasă, parcare, acces copii), link comandă/rezervare.', 'Fotografii recente și postări săptămânale.', 'Răspundeți la toate recenziile.'], acceptance: 'Profil verificat, 100% complet, sincronizat cu site-ul.' },
  bing_places: { category: 'entity', critical: true, impact: 5, effort: 1, confidence: 4, generator: 'nap', why: 'ChatGPT și Copilot se sprijină pe indexul Bing și pe Bing Places — un profil Bing lipsă este o cauză frecventă de absență din ChatGPT.', steps: ['Revendicați business-ul pe bingplaces.com (se poate importa din GBP).', 'Verificați că NAP-ul și programul sunt identice cu GBP.', 'Trimiteți site-ul în Bing Webmaster Tools.'], acceptance: 'Profil Bing Places verificat, identic cu GBP.' },
  directories: { category: 'entity', impact: 4, effort: 2, confidence: 4, generator: 'nap', why: 'Directoarele și platformele de recenzii sunt o parte mare din sursele citate pentru business-uri locale.', steps: ['Revendicați/actualizați: Apple Business Connect, Facebook, Tripadvisor, Foursquare, Glovo/Tazz/Bolt Food (dacă e cazul).', 'Același NAP și program peste tot.', 'Cereți corectarea listărilor vechi.'], acceptance: 'Toate profilurile din fișa NAP sunt revendicate și consistente.' },
  ecom_comparators: { category: 'offsite', impact: 4, effort: 2, confidence: 4, why: 'Comparatoarele și feed-urile de produse apar des în răspunsurile „de unde cumpăr X”.', steps: ['Configurați Google Merchant Center cu feed complet (preț, stoc, GTIN).', 'Listați produsele pe comparatoarele relevante (compari.ro, ShopMania, Price.ro).', 'Verificați că prețurile și stocul din feed se potrivesc cu site-ul.'], acceptance: 'Feed activ și listări pe comparatoarele citate în tab-ul Surse.' },
  ecom_trust: { category: 'reputation', impact: 4, effort: 2, confidence: 4, generator: 'reviews', why: 'Întrebările „magazin de încredere” se bazează pe recenzii terțe și pe politici clare.', steps: ['Profil Trustpilot activ + invitații automate după livrare.', 'Pagini clare pentru livrare, retur, garanție, cu cifre (zile, costuri).', 'Linkuri ANPC/SOL și date firmă vizibile în footer.'], acceptance: 'Profiluri de recenzii active și politici publicate ca text.' },
  b2b_profiles: { category: 'reputation', impact: 4, effort: 3, confidence: 4, why: 'Pentru prompturi B2B, platformele de review și comparație sunt citate des.', steps: ['Creați/completați profilurile G2, Capterra, Trustpilot, LinkedIn Company.', 'Cereți recenzii clienților reali.', 'Mențineți descrierea identică cu site-ul.'], acceptance: 'Profiluri active cu recenzii recente.' },
  cited_sources_presence: { category: 'offsite', impact: 5, effort: 4, confidence: 4, why: 'Brandurile numite de AI sunt cele care apar clar în paginile citate — în mare parte pagini terțe.', steps: ['Deschideți tab-ul Surse, sortați după „Gap”.', 'Pentru fiecare sursă cu gap mare, urmați acțiunea dedicată (outreach, profil, recenzii).'], acceptance: 'Prezent în ≥ 50% din sursele terțe frecvent citate.' },
  reviews: { category: 'reputation', critical: true, impact: 5, effort: 3, confidence: 4, generator: 'reviews', why: 'Volumul, recența și detaliul recenziilor influențează recomandările AI. Nu cumpărați recenzii — încalcă politicile și pot duce la suspendare.', steps: ['Invitație după comandă/serviciu (email, SMS sau QR pe ambalaj/la locație) spre platforma de recenzii relevantă.', 'Mesaj după comandă cu link de recenzie (fără stimulente interzise).', 'Răspundeți factual la fiecare recenzie în 48h.', 'Rezolvați problemele recurente menționate.'], acceptance: 'Ritm constant de recenzii noi lunar și rată de răspuns 100%.' },
  press_mentions: { category: 'offsite', impact: 4, effort: 4, confidence: 3, generator: 'outreach', why: 'Un articol într-o publicație citată de AI cântărește mai mult decât multe postări pe blogul propriu.', steps: ['Identificați din Surse publicațiile/ghidurile locale citate.', 'Pregătiți o poveste cu un fapt nou (lansare, cifră originală, eveniment).', 'Trimiteți pitch-ul generat.'], acceptance: 'Minimum o mențiune nouă pe o sursă citată de AI.' },
  baseline_engines: { category: 'measurement', impact: 4, effort: 1, confidence: 5, why: 'Fără baseline pe mai multe motoare nu putem măsura progresul. Motoarele nu sunt de acord între ele.', steps: ['Configurați cheile API (ChatGPT, Gemini, Perplexity, Claude).', 'Rulați setul de prompturi cu 3 repetiții.'], acceptance: 'Baseline pe ≥ 3 motoare, cu dată și eșantion.' },
  visibility_rate: { category: 'measurement', impact: 5, effort: 3, confidence: 3, why: 'Indicatorul principal: în câte răspunsuri comerciale apare brandul.', steps: ['Lucrați acțiunile P0/P1 de mai sus.', 'Re-rulați săptămânal și urmăriți trendul pe motor.'], acceptance: 'Vizibilitate ≥ 40% pe prompturile comerciale.' },
  citation_rate: { category: 'content', impact: 4, effort: 3, confidence: 3, generator: 'brief', why: 'Când site-ul propriu este citat, controlezi faptele din răspuns și primești trafic.', steps: ['Creați pagini answer-ready pentru prompturile unde competitorii sunt citați.', 'Adăugați fapte și date originale.'], acceptance: 'Domeniul propriu citat în ≥ 20% din răspunsuri.' },
  ai_accuracy: { category: 'entity', critical: true, impact: 5, effort: 2, confidence: 4, generator: 'nap', why: 'AI-ul afișează date greșite despre tine (telefon/adresă). Clienții pot suna la alt număr.', steps: ['Vedeți în Prompt Lab ce sursă conține datele greșite.', 'Corectați sursa (profil vechi, director, articol) și site-ul.', 'Re-rulați prompturile de brand.'], acceptance: 'Zero răspunsuri cu date greșite la următoarea rulare.' },
  ga4_ai_channel: { category: 'measurement', impact: 3, effort: 1, confidence: 3, generator: 'ga4', why: 'Fără canal AI în GA4 nu vezi traficul și conversiile venite din ChatGPT/Perplexity/Gemini.', steps: ['GA4 → Admin → Channel groups → creați grupul „AI Traffic” cu regex-ul generat, plasat deasupra „Referral”.', 'Configurați evenimente: apel, direcții, comandă, rezervare.', 'Adăugați întrebarea „Cum ne-ați găsit?” cu opțiunea „ChatGPT/AI”.'], acceptance: 'Canal AI vizibil în rapoarte; evenimentele de conversie testate.' },
  llms_txt: { category: 'technical', impact: 1, effort: 1, confidence: 1, generator: 'llms', why: 'Opțional. Cost mic, dar nu există dovezi că motoarele majore îl folosesc. Nu îl prioritizați.', steps: ['Generați fișierul și publicați-l la /llms.txt doar după ce restul e făcut.'], acceptance: 'Opțional.' },
};

function prio(impact: number, gap: number, confidence: number, effort: number, critical = false): { priorityScore: number; priority: 'P0' | 'P1' | 'P2' } {
  const s = Math.round(((impact * gap * confidence) / effort) * 10) / 10;
  const p = (critical && gap >= 4) || s >= 55 ? 'P0' : s >= 18 ? 'P1' : 'P2';
  return { priorityScore: s, priority: p };
}

function fromFinding(f: Finding): ActionItem | null {
  if (f.status === 'pass' || f.status === 'na') return null;
  const t = T[f.id];
  if (!t) return null;
  const gap = f.status === 'fail' ? 5 : f.status === 'manual' ? 4 : 3;
  return {
    key: `check:${f.id}`,
    category: t.category,
    title: f.title,
    why: t.why,
    steps: t.steps,
    acceptance: t.acceptance,
    impact: t.impact,
    effort: t.effort,
    confidence: t.confidence,
    gap,
    ...prio(t.impact, gap, t.confidence, t.effort, t.critical),
    generator: t.generator,
    evidence: [f.detail, ...f.evidence].filter(Boolean),
    manual: f.manual,
  };
}

const SOURCE_PLAYBOOK: Partial<Record<string, { steps: string[]; generator?: GeneratorKind; effort: number }>> = {
  directory: { effort: 1, generator: 'nap', steps: ['Revendicați / creați profilul pe acest director.', 'Completați datele (nume, adresă, telefon, program, ofertă) identic cu site-ul.', 'Cereți clienților recenzii și pe această platformă.'] },
  review: { effort: 2, generator: 'reviews', steps: ['Creați/revendicați profilul.', 'Invitați clienți reali să lase recenzii.', 'Răspundeți la recenzii.'] },
  delivery: { effort: 1, steps: ['Listați-vă pe platformă (sau actualizați listarea).', 'Meniu complet cu descrieri și poze; mențineți rating-ul.'] },
  ugc: { effort: 3, steps: ['Identificați discuțiile citate (URL-urile de mai jos).', 'Participați autentic, ca reprezentant declarat al business-ului — fără spam sau conturi false.', 'Răspundeți la întrebări reale cu informații utile.'] },
  news: { effort: 4, generator: 'outreach', steps: ['Citiți articolele citate de AI (mai jos).', 'Propuneți redacției o poveste locală cu un fapt nou sau o cifră originală.', 'Cereți actualizarea articolelor de tip „top” care nu vă includ.'] },
  editorial: { effort: 3, generator: 'outreach', steps: ['Deschideți articolele / listele citate (mai jos).', 'Contactați autorul cu informații verificabile și cereți includerea / actualizarea.', 'Oferiți fotografii și date pentru o evaluare corectă.'] },
  social: { effort: 2, steps: ['Asigurați un profil activ, cu NAP și link spre site.', 'Publicați conținut cu fapte (oferte noi, program, evenimente).'] },
  maps: { effort: 2, generator: 'nap', steps: ['Verificați și completați profilul de hărți (GBP / Apple Maps / Bing Maps).'] },
  marketplace: { effort: 3, steps: ['Evaluați listarea pe marketplace (descrieri complete, recenzii).'] },
  reference: { effort: 4, steps: ['Verificați dacă business-ul îndeplinește criteriile de notorietate; altfel nu forțați (Wikipedia/Wikidata).'] },
};

function fromSource(s: SourceRow): ActionItem | null {
  if (['owned', 'competitor', 'brand', 'authority', 'reference'].includes(s.type) || s.gapScore < 15 || s.answers < 2) return null;
  const pb = SOURCE_PLAYBOOK[s.type] ?? SOURCE_PLAYBOOK.editorial!;
  const gap = s.gapScore >= 60 ? 5 : s.gapScore >= 35 ? 4 : 3;
  const impact = s.share >= 0.15 ? 5 : s.share >= 0.07 ? 4 : 3;
  return {
    key: `source:${s.domain}`,
    category: 'offsite',
    title: `Intră pe ${s.domain} (${SOURCE_TYPE_LABEL[s.type]})`,
    why: `AI-ul citează ${s.domain} în ${Math.round(s.share * 100)}% din răspunsurile cu surse; în ${s.withCompetitors} din ${s.answers} apar alții, dar nu tu.`,
    steps: pb.steps,
    acceptance: `Brandul apare pe ${s.domain}, iar la re-rulare sursa apare și în răspunsuri care te menționează.`,
    impact,
    effort: pb.effort,
    confidence: 3,
    gap,
    ...prio(impact, gap, 3, pb.effort),
    generator: pb.generator,
    generatorArg: s.domain,
    evidence: s.urls.slice(0, 5).map((u) => `${u.url} (×${u.count})`),
  };
}

function fromPrompts(m: MetricsReport): ActionItem[] {
  return m.prompts
    .filter((p) => p.intent !== 'brand' && Object.keys(p.perEngine).length && p.visibility === 0 && p.winners.length)
    .slice(0, 8)
    .map((p) => ({
      key: `prompt:${p.promptId}`,
      category: 'content' as ActionCategory,
      title: `Pagină answer-ready pentru: „${p.text}”`,
      why: `Pentru acest prompt AI-ul recomandă ${p.winners.slice(0, 3).map((w) => w.brand).join(', ')} — tu nu apari deloc.`,
      steps: ['Generați brief-ul de conținut pentru acest prompt.', 'Publicați o pagină (sau secțiune) care răspunde direct întrebării în primele 2-3 fraze, cu fapte și prețuri.', 'Verificați sursele citate pentru acest prompt în Prompt Lab și urmați acțiunile de surse.'],
      acceptance: 'La următoarele 2 rulări brandul apare pe acest prompt în cel puțin un motor.',
      impact: 4,
      effort: 3,
      confidence: 3,
      gap: 5,
      ...prio(4, 5, 3, 3),
      generator: 'brief' as GeneratorKind,
      generatorArg: p.promptId,
      evidence: p.winners.map((w) => `${w.brand} ×${w.count}`),
    }));
}

const ENGINE_ECOSYSTEM: Partial<Record<EngineId, { title: string; why: string; steps: string[]; generator?: GeneratorKind }>> = {
  chatgpt: { title: 'Ecosistemul Bing (ChatGPT/Copilot)', why: 'ChatGPT se sprijină pe indexul Bing și pe surse terțe; vizibilitatea scăzută aici indică de obicei Bing Places lipsă, site nesubmis în Bing sau absență din directoare.', steps: ['Revendicați Bing Places și trimiteți site-ul în Bing Webmaster Tools (IndexNow).', 'Verificați că OAI-SearchBot are acces.', 'Lucrați sursele terțe citate de ChatGPT (filtru motor în Surse).'], generator: 'nap' },
  gemini: { title: 'Ecosistemul Google (Gemini/AI Overviews)', why: 'Gemini folosește Google Search, Maps și Google Business Profile; vizibilitatea scăzută indică profil GBP incomplet, recenzii puține sau site slab indexat în Google.', steps: ['Completați GBP 100% și cereți recenzii Google.', 'Verificați indexarea în Search Console.', 'Asigurați schema LocalBusiness corectă.'], generator: 'nap' },
  perplexity: { title: 'Surse proaspete și liste (Perplexity)', why: 'Perplexity citează multe surse (liste „top”, presă, forumuri) și preferă conținut recent.', steps: ['Intrați pe listele/articolele citate de Perplexity (Surse → filtru motor).', 'Actualizați datele pe site și afișați data actualizării.', 'Verificați accesul PerplexityBot.'], generator: 'outreach' },
  claude: { title: 'Surse web independente (Claude)', why: 'Claude citează surse web independente; prezența pe site-uri de încredere și conținutul factual ajută.', steps: ['Verificați accesul Claude-SearchBot.', 'Creați conținut citabil (fapte, cifre, FAQ).', 'Lucrați sursele terțe citate de Claude.'], generator: 'brief' },
};

function fromEngines(m: MetricsReport): ActionItem[] {
  const out: ActionItem[] = [];
  const overall = m.overall.visibility;
  for (const [e, b] of Object.entries(m.byEngine) as [EngineId, NonNullable<MetricsReport['byEngine'][EngineId]>][]) {
    const eco = ENGINE_ECOSYSTEM[e];
    if (!eco || b.n < 3) continue;
    if (b.visibility < 0.15 || (overall > 0 && b.visibility < overall * 0.5)) {
      const gap = b.visibility === 0 ? 5 : 4;
      out.push({ key: `engine:${e}`, category: 'offsite', title: `Vizibilitate scăzută în ${e === 'chatgpt' ? 'ChatGPT' : e[0].toUpperCase() + e.slice(1)}: ${eco.title}`, why: `${Math.round(b.visibility * 100)}% vizibilitate (n=${b.n}) vs ${Math.round(overall * 100)}% media. ${eco.why}`, steps: eco.steps, acceptance: `Vizibilitate în ${e} ≥ media celorlalte motoare.`, impact: 4, effort: 2, confidence: 3, gap, ...prio(4, gap, 3, 2), generator: eco.generator, evidence: [] });
    }
  }
  return out;
}

export function buildActions(p: Project, audit: AuditResult | null, metrics: MetricsReport | null, sources: SourceRow[]): ActionItem[] {
  const out: ActionItem[] = [];
  if (audit) for (const f of audit.findings) {
    const a = fromFinding(f);
    if (a) out.push(a);
  }
  // Verificările manuale apar ca acțiuni chiar înainte de primul audit.
  if (!audit) {
    for (const id of ['gbp_complete', 'bing_places', 'directories', 'reviews', 'ga4_ai_channel']) {
      if ((id === 'gbp_complete' || id === 'bing_places' || id === 'directories') && !['restaurant', 'local_service'].includes(p.vertical)) continue;
      const a = fromFinding({ id, pillar: 'offsite', title: TITLES[id] ?? id, weight: 1, status: 'manual', detail: '', evidence: [], manual: true });
      if (a) out.push(a);
    }
  }
  if (metrics) out.push(...fromPrompts(metrics), ...fromEngines(metrics));
  for (const s of sources.slice(0, 40)) {
    const a = fromSource(s);
    if (a) out.push(a);
  }
  const order = { P0: 0, P1: 1, P2: 2 };
  return out.sort((a, b) => order[a.priority] - order[b.priority] || b.priorityScore - a.priorityScore);
}

const TITLES: Record<string, string> = {
  gbp_complete: 'Google Business Profile complet și verificat',
  bing_places: 'Bing Places revendicat și identic cu GBP',
  directories: 'Profiluri consistente în directoare',
  reviews: 'Recenzii autentice: volum constant, recente, cu răspuns',
  ga4_ai_channel: 'GA4: canal „AI Traffic” + evenimente de conversie',
};
