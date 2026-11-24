// CLI rapid: audit GEO pentru orice site, fără interfață.
//   npm run audit -- pizzerialuna.ro --city Iași --vertical restaurant --phone "0740 111 222"

import { PILLAR_LABEL, runAudit } from './core/audit.ts';
import { crawlSite } from './core/crawler.ts';
import { buildActions } from './core/recommend.ts';
import type { Project, Vertical } from './core/types.ts';
import { domainOf } from './core/util.ts';

const args = process.argv.slice(2);
if (args[0] === 'audit') args.shift();
const domain = args.find((a) => !a.startsWith('--'));
const opt = (k: string) => {
  const i = args.indexOf(`--${k}`);
  return i >= 0 ? args[i + 1] : undefined;
};
if (!domain) {
  console.log('Folosire: npm run audit -- <domeniu> [--city Iași] [--vertical restaurant|local_service|ecommerce|b2b] [--phone ...] [--address ...] [--services "a, b"] [--pages 25]');
  process.exit(1);
}

const p: Project = {
  id: 'cli', name: opt('name') ?? domainOf(domain), domain: domainOf(domain), aliases: [], competitors: [],
  vertical: (opt('vertical') as Vertical) ?? 'generic', country: 'RO', city: opt('city'), neighborhoods: [],
  services: (opt('services') ?? '').split(',').map((s) => s.trim()).filter(Boolean), languages: ['ro'], engines: [], repetitions: 3,
  schedule: 'manual', facts: { phone: opt('phone'), address: opt('address') }, shareToken: '', createdAt: new Date().toISOString(),
};

const icon = { pass: '✓', warn: '!', fail: '✗', manual: '○', na: '–' };
console.log(`\nAuditez ${domain}…`);
const crawl = await crawlSite(domain, { maxPages: Number(opt('pages') ?? 25) });
const audit = runAudit({ project: p, crawl, manualDone: new Set() });
console.log(`\nScor GEO: ${audit.score}/100  (${audit.pagesCrawled} pagini)\n`);
for (const [k, v] of Object.entries(audit.pillarScores)) console.log(`  ${PILLAR_LABEL[k as keyof typeof PILLAR_LABEL].padEnd(32)} ${v.score}/${v.max}`);
console.log('\nVerificări:');
for (const f of audit.findings) console.log(`  ${icon[f.status]} ${f.title}\n      ${f.detail}`);
console.log('\nAcces boți AI:');
for (const b of audit.bots) console.log(`  ${b.token.padEnd(18)} robots: ${b.robotsAllowed ? 'permis' : 'BLOCAT'}${b.liveStatus !== undefined ? `   live: ${b.liveBlocked ? 'BLOCAT ' : ''}${b.liveStatus}` : ''}`);
console.log('\nPrimele acțiuni:');
for (const a of buildActions(p, audit, null, []).slice(0, 10)) console.log(`  [${a.priority}] ${a.title}`);
console.log('');
