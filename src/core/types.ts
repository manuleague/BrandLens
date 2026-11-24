// BrandLens — tipuri comune ale motorului GEO.

export type EngineId = 'chatgpt' | 'claude' | 'gemini' | 'perplexity' | 'simulator';

export type Vertical = 'restaurant' | 'local_service' | 'ecommerce' | 'b2b' | 'generic';

export type Lang = 'ro' | 'en';

export interface Competitor {
  name: string;
  domain?: string;
  aliases?: string[];
}

/** „Setul de adevăr” aprobat de client — folosit la NAP, schema și verificarea acurateței AI. */
export interface Facts {
  legalName?: string;
  address?: string;
  city?: string;
  postalCode?: string;
  phone?: string;
  email?: string;
  hours?: string; // ex: "Mo-Su 11:00-23:00"
  priceRange?: string; // ex: "40-80 lei"
  cuisine?: string; // restaurante
  description?: string;
  foundedYear?: string;
  lat?: number;
  lng?: number;
  menuUrl?: string;
  orderUrl?: string;
  profiles?: string[]; // GBP, Facebook, Instagram, Tripadvisor... (sameAs)
}

export interface Topic {
  name: string;
  description?: string;
}

export interface Persona {
  name: string;
  description: string; // cum se descrie utilizatorul în conversație
}

export interface Project {
  id: string;
  name: string; // numele brandului
  domain: string; // ex: pizzeria-exemplu.ro
  aliases: string[];
  competitors: Competitor[];
  vertical: Vertical;
  category?: string; // ex: „pizzerie”, „clinică stomatologică” — folosit în prompturi
  categoryEn?: string; // ex: „pizzeria”
  country: string; // ISO-2
  city?: string;
  region?: string;
  neighborhoods: string[];
  services: string[];
  topics?: Topic[]; // grupuri de întrebări (ca „Topics” din Ahrefs / Semrush)
  personas?: Persona[]; // tipuri de cumpărător (ca GEOflux: fiecare întrebare pusă și ca persone)
  usePersonas?: boolean;
  scope?: 'local' | 'national' | 'international';
  description?: string;
  usps?: string[];
  languages: Lang[];
  engines: EngineId[];
  repetitions: number;
  schedule: 'manual' | 'daily' | 'weekly';
  facts: Facts;
  shareToken: string;
  createdAt: string;
  demo?: boolean;
}

export type PromptIntent = 'category' | 'comparison' | 'use_case' | 'local' | 'price' | 'brand' | 'trust';

export interface PromptDef {
  id: string;
  projectId: string;
  text: string;
  lang: Lang;
  intent: PromptIntent;
  tags: string[];
  active: boolean;
  topic?: string;
  stage?: 'awareness' | 'consideration' | 'decision';
  origin?: 'ai' | 'template' | 'manual';
}

export interface Citation {
  url: string;
  title?: string;
  domain: string;
  /** cited = apare explicit în răspuns; retrieved = consultată în căutare, dar nu neapărat citată */
  kind: 'cited' | 'retrieved';
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  searches?: number;
  costUsd?: number;
  analysisCostUsd?: number;
}

export interface EngineResult {
  engine: EngineId;
  model: string;
  text: string;
  citations: Citation[];
  searchQueries: string[];
  usage: Usage;
  latencyMs: number;
  error?: string;
  simulated?: boolean;
}

export interface EngineRequest {
  prompt: string;
  lang: Lang;
  country: string;
  city?: string;
  region?: string;
  lat?: number;
  lng?: number;
  local: boolean;
}

export interface Mention {
  brand: string; // nume canonic
  own: boolean;
  tracked: boolean; // e în lista de competitori/brand (vs. descoperit)
  position: number; // 1 = primul brand numit
  recommended: boolean;
  sentiment: number; // 0..10
  snippet: string;
}

export interface AccuracyIssue {
  field: 'phone' | 'address' | 'hours';
  expected: string;
  found: string;
  snippet: string;
}

/** Un brand numit într-un răspuns (urmărit sau descoperit), cu ce spune AI-ul despre el. */
export interface BrandHit {
  name: string; // nume canonic
  own: boolean;
  tracked: boolean;
  position: number;
  recommended: boolean;
  sentiment: number; // 0..10
  attributes: { text: string; polarity: 'pos' | 'neg' | 'neu' }[];
}

export interface Extraction {
  mentions: Mention[];
  ownMentioned: boolean;
  ownCited: boolean;
  ownPosition: number | null;
  ownRecommended: boolean;
  ownSentiment: number | null;
  discovered: string[]; // entități numite care nu sunt urmărite
  ranked: string[]; // ordinea în care apar toate entitățile (urmărite + descoperite)
  accuracy: AccuracyIssue[];
  refusal: boolean;
  brands?: BrandHit[]; // toate brandurile numite, în ordine
  analysis?: 'llm' | 'rules';
}

export interface StoredResult {
  id: string;
  projectId: string;
  runId: string;
  promptId: string;
  engine: EngineId;
  model: string;
  rep: number;
  createdAt: string;
  text: string;
  citations: Citation[];
  searchQueries: string[];
  usage: Usage;
  latencyMs: number;
  error?: string;
  simulated?: boolean;
  persona?: string;
  extraction: Extraction;
}

export type CheckStatus = 'pass' | 'warn' | 'fail' | 'manual' | 'na';

export type Pillar = 'access' | 'entity' | 'content' | 'offsite' | 'visibility';

export interface Finding {
  id: string; // id-ul verificării, stabil
  pillar: Pillar;
  title: string;
  weight: number;
  status: CheckStatus;
  detail: string;
  evidence: string[];
  manual?: boolean; // se bifează de om (ex. Google Business Profile)
}

export interface AuditResult {
  url: string;
  startedAt: string;
  finishedAt: string;
  pagesCrawled: number;
  score: number;
  pillarScores: Record<Pillar, { score: number; max: number }>;
  findings: Finding[];
  pages: PageSummary[];
  bots: BotAccess[];
  notes: string[];
  /** Versiunea regulilor de audit; un audit mai vechi decât AUDIT_VERSION e refăcut automat. */
  version?: number;
  /** Site-ul nu a putut fi citit (pagina principală a întors eroare); verificările de conținut nu au rulat. */
  unreadable?: { status: number; reason: string };
}

export interface PageSummary {
  url: string;
  status: number;
  title: string;
  h1: string[];
  words: number;
  schemaTypes: string[];
  noindex: boolean;
  jsOnly: boolean;
  ms: number;
}

export interface BotAccess {
  token: string;
  operator: string;
  purpose: 'search' | 'user' | 'training';
  robotsAllowed: boolean;
  robotsLine?: string;
  liveStatus?: number; // status HTTP la cererea cu UA-ul botului
  liveBlocked?: boolean;
  /** De ce considerăm răspunsul blocat (cod de refuz, pagină de verificare, răspuns mult mai mic decât în browser). */
  liveReason?: string;
  liveBytes?: number;
}

export type ActionStatus = 'todo' | 'in_progress' | 'done' | 'verified' | 'wontfix';

export type ActionCategory = 'technical' | 'entity' | 'content' | 'offsite' | 'reputation' | 'measurement';

export type GeneratorKind = 'schema' | 'robots' | 'faq' | 'brief' | 'outreach' | 'ga4' | 'nap' | 'reviews' | 'llms';

export interface UsageLog {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface ActionItem {
  key: string; // stabil: check:<id> | source:<domain> | prompt:<id> | engine:<id>
  category: ActionCategory;
  title: string;
  why: string;
  steps: string[];
  acceptance: string;
  impact: number; // 1-5
  effort: number; // 1-5
  confidence: number; // 1-5
  gap: number; // 1-5
  priorityScore: number;
  priority: 'P0' | 'P1' | 'P2';
  generator?: GeneratorKind;
  generatorArg?: string;
  evidence: string[];
  manual?: boolean;
  aiGenerated?: boolean;
}

export interface MetricBlock {
  n: number; // răspunsuri valide
  visibility: number; // 0..1
  visibilityCi: [number, number];
  citationRate: number;
  shareOfVoice: number;
  avgPosition: number | null;
  recommendationRate: number; // din răspunsurile care te menționează
  sentiment: number | null; // 0..10
  errors: number;
}
