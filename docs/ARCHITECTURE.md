# Arhitectură și drum spre producție

## Fluxul datelor

```
Proiect (brand, domeniu, oraș, servicii, competitori, set de adevăr)
  ├─► generatePrompts ──► prompts
  ├─► job „audit”  ──► crawlSite ──► runAudit ──► audits (scor, constatări, boți)
  └─► job „run”    ──► pentru fiecare prompt × motor × repetare:
                         runEngine (API oficial + căutare web)
                         └─► extract (mențiuni, poziție, recomandare, sentiment, descoperiri, acuratețe)
                              └─► results
Citire (dashboard):
  results ──► computeMetrics (vizibilitate + Wilson, SoV, grilă, trend)
          ──► analyzeSources (tipuri, gap)
  audits  ──► liveAudit (verificările dinamice se recalculează din tracking + bife manuale)
  toate   ──► buildActions (prioritate = Impact × Gap × Încredere ÷ Efort)
              + actions (status, responsabil, dovadă; separate de recomandare ca să nu se piardă bifele)
```

## Model de date (SQLite acum, PostgreSQL la scară)

| Tabel | Cheie | Conținut |
|---|---|---|
| projects | id | JSON: brand, domeniu, verticală, categorie, oraș, cartiere, servicii, competitori, motoare, programare, set de adevăr, token raport |
| prompts | id | text, limbă, intenție, etichete, activ |
| runs | id | motoare, total, terminate, erori, cost, declanșator |
| results | id | prompt, motor, model, repetare, text, citări, interogări, cost, eroare, extracție |
| audits | id | scor, JSON audit (constatări, pagini, boți) |
| actions | (project_id, key) | status, responsabil, URL dovadă, notă, termen |
| jobs | id | tip, payload, status, încercări; reluare după restart |

Migrare la PostgreSQL: aceleași tabele, cu `jsonb` pentru câmpurile JSON, `organization_id` pe `projects` pentru multi-tenant și row-level security pe `organization_id`.

## Etapele de producție

1. **Acum (MVP, 1–20 clienți):** un proces, SQLite WAL, autentificare Basic, deploy pe App Service sau VM.
2. **Agenție (20–200 clienți):** PostgreSQL, worker separat (pg-boss), utilizatori și roluri (owner, analist, client cu aprobare), white-label pe raport, alerte email/Slack la scăderea SoV.
3. **SaaS:** OAuth Google (GA4 Data API, Search Console API, Business Profile API) cu permisiuni minime, connector Ahrefs/Moz/Semrush pentru autoritatea surselor citate, billing pe credite (1 prompt × 1 motor = 1 credit; Claude/Gemini cu Maps ponderat mai sus), loguri de crawler AI din Cloudflare/server (ca Profound Agent Analytics).

## Puncte de extensie

- **Motor nou** (Copilot, Grok, Google AI Mode prin furnizor de date): un adaptor în `engines.ts` care întoarce `EngineResult`.
- **Verificare nouă de audit:** o intrare în `CHECKS` (`audit.ts`) și un șablon în `recommend.ts`.
- **Generator nou:** o funcție în `generators.ts` și eticheta în `web/app.js`.
- **Verticală nouă:** șabloane în `prompts.ts` și reguli de proprietăți schema în `audit.ts`.
