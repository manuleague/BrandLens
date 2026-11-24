# BrandLens

Platformă GEO + SEO pentru agenții și business-uri: măsoară dacă **ChatGPT, Gemini, Perplexity și Claude** recomandă un brand, arată **ce surse** citează AI-ul, **auditează site-ul** pentru citirea de către AI și transformă totul într-un **plan de acțiuni bifabil**, cu scor care crește pe măsură ce lucrurile se implementează.

Lanțul pe care îl urmărește aplicația, de la un capăt la altul:

**prompt → răspuns → mențiune / citare → problemă → acțiune → implementare (dovadă) → re-măsurare**

---

## Pornire rapidă (Windows, macOS, Linux)

Cerință: **Node.js 24 LTS** (sau ≥ 22.18). **Nu există `npm install`**: aplicația nu are dependențe externe.

```powershell
cd C:\BrandLens
copy .env.example .env      # completați cheile API pe care le aveți (opțional)
npm start
```

Deschideți **http://127.0.0.1:4321**:

- **Proiect demo**: apăsați „Deschide proiectul demo”. Răspunsurile sunt simulate, ca să explorați aplicația fără chei API.
- **Proiect real**: „Proiect nou”, completați brandul, site-ul, orașul, serviciile și competitorii. Auditul site-ului pornește imediat. Rularea prompturilor pornește doar dacă aveți cel puțin o cheie API în `.env`.

Alte comenzi:

| Comandă | Ce face |
|---|---|
| `npm run dev` | server cu repornire automată la modificări |
| `npm test` | 20 de teste: robots.txt, parser HTML, extracție, adaptoare API, crawl + audit, sitemap .gz, WAF, profilare, prompturi AI, analiză LLM, loguri, chei invalide, analitică |
| `npm run audit -- exemplu.ro --city Iași --vertical restaurant --phone "0740 111 222"` | audit GEO din linia de comandă, fără interfață |
| `npm run typecheck` | verificare TypeScript (necesită `tsc` instalat global) |

### Docker

```bash
cp .env.example .env
docker compose up -d --build     # http://localhost:4321, datele rămân în volumul brandlens-data
```

---

## Versiunea 2: ce s-a adăugat

| Ecran | Ce face | Echivalent la |
|---|---|---|
| **Proiect nou cu analiză AI** | Introduci domeniul; aplicația citește paginile, extrage datele din schema/contact și (cu cheie AI) propune categoria, topicurile, personele, competitorii, acoperirea | Onboarding Peec / Semrush, „Suggest more” Ahrefs |
| **Prompt research cu AI** | Întrebări realiste pe topicuri × intenții × etape (descoperire/evaluare/decizie), fără numele brandului | Semrush Prompt Research, Moz Prompt Suggestions |
| **Persone** | Fiecare întrebare poate fi pusă și „ca” fiecare tip de cumpărător | GEOflux (3 persone per întrebare) |
| **Analiza AI a fiecărui răspuns** | Toate brandurile numite, poziție, recomandat sau nu, ton 0–10, ce spune AI-ul despre fiecare | GEOflux tone score, Semrush Perception |
| **Competitori** | Share of answers, SoV, poziție, recomandare, ton, locul 1, pe motor, pentru TOATE brandurile numite; „Urmărește” cu un click | GEOflux State of AI, Ahrefs Overview |
| **Brandul ales de fiecare AI** | Nr. 1 per motor, locul tău, branduri/surse per răspuns | GEOflux „AI tool #1” |
| **Share of answers în timp** | Tu vs. top 5, pe zile | Moz „Share of Mentions Over Time” |
| **Topicuri** | Vizibilitate și lider pe fiecare grup de întrebări | Ahrefs / Semrush Topics |
| **Surse** | Grupe (brand, marketplace, media, review, comunitate, autoritate), paginile tale citate, paginile competitorilor, interogările fan-out | GEOflux Sources, Ahrefs Cited pages + fan-out |
| **Percepție** | Ce apreciază și ce reproșează AI-ul, ton pe motor, citate, atributele competitorilor | Semrush Perception |
| **Recomandări AI din date** | Acțiuni specifice brandului, generate din prompturile pierdute, sursele cu gap, percepție și audit, cu dovezi | Peec Actions |
| **Optimizator de conținut** | Pagina ta vs. paginile citate de AI pentru aceeași întrebare: 11 verificări + rescrieri (răspuns direct, fapte lipsă, FAQ, structură) | Moz AI Content Briefs, Otterly |
| **Crawlere AI** | Upload de loguri IIS / Nginx / Cloudflare: vizite boți AI, blocaje, pagini nevizitate, trafic uman din ChatGPT/Perplexity | Profound Agent Analytics |
| **Testează conexiunile** | Verifică fiecare cheie API și explică eroarea (cheie greșită, token de abonament, model indisponibil) | — |

### Dacă vedeți „—” peste tot după o rulare

Aproape sigur o cheie API e respinsă. Interfața afișează acum eroarea exactă în banner, iar butonul **Testează conexiunile** (stânga jos) explică ce e greșit. La pornire, consola serverului arată ✓/✗ pentru fiecare motor. Pentru Claude: cheia trebuie creată în console.anthropic.com → API Keys (începe cu `sk-ant-api`) și contul trebuie să aibă credit.

### Securitate când expuneți aplicația (devtunnel, ngrok etc.)

Setați `BRANDLENS_PASSWORD` în `.env`. Altfel oricine are linkul poate porni rulări pe cheile dvs. API.

---

## Ce face, modul cu modul

| Modul | Ce vezi în aplicație | Inspirat din | Ce face în plus |
|---|---|---|---|
| **Prompturi** | Set generat din categorie, oraș, cartiere, servicii și competitori, distribuit pe intenții (categorie, comparație, local, caz de utilizare, preț, încredere). Se editează. | GEOflux, Ahrefs (prompturi din intenții reale) | Prompturile de descoperire **nu conțin numele brandului**. Cele de brand sunt separate și măsoară doar acuratețea. |
| **Tracking** | Rulează fiecare prompt pe fiecare motor, de 3+ ori, cu localizare (țară/oraș). Programare zilnică sau săptămânală. | GEOflux, Peec, Otterly | Interval de încredere Wilson pe vizibilitate și `n` afișat peste tot. Promptul e marcat „variabil” dacă rezultatul diferă între repetări. |
| **Grila „Pe ce loc te pune fiecare AI”** | Pentru fiecare motor: cine ocupă locurile 1–6 și cât de des ești tu acolo. | — | Arată dintr-o privire diferențele între motoare (ChatGPT ≠ Gemini). |
| **Competitori descoperiți** | Branduri numite des în răspunsuri, dar neurmărite. | Peec („pe cine alege AI-ul în locul tău”) | Intră automat în clasament, marcate „nou”. |
| **Acuratețe** | Alertă când AI-ul dă alt telefon sau altă adresă decât setul de adevăr. | b2b-seo-company („audit de consens”) | Automat, pe fiecare răspuns. |
| **Surse citate** | Domenii și URL-uri citate, pe tip (directoare, recenzii, livrare, presă, forum etc.), cu scor de oportunitate. | Peec Actions, Semrush AI-Cited Media | Clasificare adaptată României (presă locală, Glovo/Tazz/Bolt Food, directoare RO). |
| **Audit GEO** | 32 de verificări în 5 piloni, scor /100: acces boți AI (robots.txt **și test live** cu user-agent-ul fiecărui bot), randare fără JS, schema, NAP, conținut answer-ready, meniu/prețuri ca text, densitate de fapte, prezență locală, măsurare. | GEOflux AI Readiness, Otterly GEO Audit, Semrush Site Audit | Verificările manuale (GBP, Bing Places, recenzii, GA4) se bifează și **scorul se recalculează live**. |
| **Plan de acțiuni** | Fiecare problemă devine o acțiune cu motiv, pași exacți, criteriu „gata când”, prioritate P0/P1/P2, responsabil, status și URL de dovadă. | Peec Actions, b2b-seo-company | Prioritate explicabilă: `Impact × Gap × Încredere ÷ Efort`. Acțiuni pe ecosistem de motor (ChatGPT → Bing; Gemini → Google). |
| **Generatoare** | JSON-LD (Restaurant/LocalBusiness/Organization), robots.txt, FAQ + schema FAQPage, brief de conținut pentru un prompt pierdut, email de outreach pentru o sursă, ghid GA4, fișă NAP, plan de recenzii, llms.txt. | Otterly (briefuri), Semrush | Câmpurile necunoscute rămân `[COMPLETAȚI]`. Nu se inventează prețuri, alergeni sau program. |
| **Raport client** | Raport HTML printabil ca PDF, link public fără cont, export CSV. | GEOflux (raport pe link), Semrush (white-label) | Include metodologia și limitele: eșantion, motoare, date. |

---

## Cum se conectează motoarele

Toate prin **API-urile oficiale, cu căutare web activă**, nu prin automatizarea aplicațiilor de consum, care ar încălca termenii de utilizare și ar fi fragilă:

| Motor | Endpoint | Unealta de căutare | Ce extragem |
|---|---|---|---|
| ChatGPT | `POST /v1/responses` | `web_search` cu `user_location` | text, `url_citation` (citate), `action.sources` (consultate), interogări |
| Claude | `POST /v1/messages` | `web_search_20250305` cu `user_location` | text, `citations`, `web_search_tool_result`, interogări |
| Gemini | `generateContent` | `google_search` (+ opțional `googleMaps`) | text, `groundingChunks` (web și Maps), `webSearchQueries` |
| Perplexity | `POST /chat/completions` (Sonar) | integrată, `web_search_options.user_location` | text, `search_results`, cost raportat |

Răspunsurile prin API pot diferi de ce vede un utilizator logat în aplicație (personalizare, istoric, locație exactă). Recomandare: verificați manual, lunar, 5–10 prompturi în aplicațiile reale și comparați. Modelele se schimbă des, așa că sunt configurabile în `.env`.

**Cost orientativ:** 30 de prompturi × 4 motoare × 3 repetări = 360 de apeluri pe rulare. La modelele implicite costul e de ordinul unor dolari pe rulare, iar aplicația afișează costul estimat. Pentru clienții mici: rulare săptămânală, 20–30 de prompturi.

---

## Arhitectură

```
web/                 interfața (HTML + CSS + JS, fără build)
src/core/            motorul GEO, fără I/O de bază de date, testabil izolat
  crawler.ts           robots.txt, sitemap, pagini prioritare, test live cu UA-urile boților AI
  audit.ts             32 de verificări, 5 piloni, scor; „live audit” = crawl + tracking + bife manuale
  prompts.ts           generator de prompturi pe intenții
  engines.ts           adaptoare ChatGPT / Claude / Gemini / Perplexity
  extract.ts           mențiuni, poziție, recomandare, sentiment, descoperiri, acuratețe (+ LLM-as-judge opțional)
  metrics.ts           vizibilitate (Wilson), SoV, poziție, citare, grila pe locuri, trend, volatilitate
  sources.ts           clasificarea surselor și scorul de oportunitate
  recommend.ts         acțiuni cu prioritate explicabilă
  generators.ts        artefacte gata de implementat
src/server/          HTTP (node:http), SQLite (node:sqlite), coadă de joburi persistentă, programator, raport
test/                testele
```

**De ce acest stack:** TypeScript peste tot, rulat direct de Node 24 (type stripping nativ), `node:sqlite` pentru stocare și `node:http` pentru server. Rezultatul: zero dependențe, deci nimic de actualizat sau de securizat în lanțul npm, pornire cu o singură comandă și un container mic. Logica stă în `src/core` și nu depinde de server, deci poate fi mutată în orice framework.

**Când creșteți** (multi-tenant SaaS, mulți clienți): schema SQLite se mută 1:1 în PostgreSQL. Coada de joburi se mută pe pg-boss sau BullMQ + Redis, cu workeri separați de API. Interfața poate fi rescrisă în Next.js peste același API. Detalii în [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

### Deploy pe Azure (recomandat)

- **Simplu (1–20 clienți):** Azure App Service (Linux, container) cu `DB_PATH=/home/data/brandlens.db` (stocare persistentă `/home`) sau o VM B1s cu Docker Compose și Caddy pentru HTTPS. Setați `BRANDLENS_PASSWORD`.
- **Scalare:** Azure Container Apps (API + worker ca aplicații separate), Azure Database for PostgreSQL Flexible Server, Key Vault pentru cheile API, Log Analytics pentru costuri și erori pe motor.
- **Evitați** SQLite pe Azure Files (SMB): blocarea fișierelor nu e sigură pentru SQLite.

---

## API (JSON)

| Metodă | Rută | Descriere |
|---|---|---|
| GET | `/api/meta` | motoare configurate, etichete |
| GET/POST | `/api/projects` | listă / creare (`autoAudit`, `autoRun`) |
| POST | `/api/demo` | creează proiectul demo |
| GET/PUT/DELETE | `/api/projects/:id` | proiect |
| GET | `/api/projects/:id/dashboard?days=30` | metrici, surse, audit live, rulări, joburi, progres |
| GET/POST | `/api/projects/:id/prompts` | prompturi |
| POST | `/api/projects/:id/prompts/generate` | sugerează prompturi noi |
| PUT/DELETE | `/api/prompts/:pid` | editare / ștergere prompt |
| POST | `/api/projects/:id/runs` | pornește o rulare (`engines`, `repetitions`, `promptIds`) |
| GET | `/api/projects/:id/results?promptId=` | răspunsuri brute + extracție |
| POST | `/api/projects/:id/audit` | pornește auditul |
| GET/PUT | `/api/projects/:id/actions` | plan de acțiuni / actualizare status, responsabil, dovadă |
| POST | `/api/projects/:id/generate/:kind` | `schema`, `robots`, `faq`, `brief`, `outreach`, `ga4`, `nap`, `reviews`, `llms` |
| GET | `/api/projects/:id/report` | raport HTML |
| GET | `/api/projects/:id/export.csv` | export răspunsuri |
| GET | `/r/:token` | raport public, fără autentificare |

---

## Limite asumate

- Nimeni nu poate garanta locul 1 într-un răspuns AI. BrandLens măsoară probabilitatea de apariție pe un eșantion fix și arată ce s-a schimbat după fiecare acțiune.
- Extracția este deterministă și explicabilă: potrivire pe nume și alias-uri, fără diacritice. Cu `LLM_JUDGE=1`, recomandarea și sentimentul se rafinează printr-un apel LLM.
- Testul live al boților folosește user-agent-ul lor, nu IP-ul. Un CDN care verifică IP-ul poate trata diferit boții reali. Confirmați în logurile CDN.
- llms.txt e inclus doar ca opțiune de prioritate minimă: datele publice arată că rar e accesat de crawlere.
