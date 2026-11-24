// Parser robots.txt (RFC 9309) cu potrivire pe user-agent și reguli cu * și $.

export interface RobotsRule {
  allow: boolean;
  path: string;
  line: number;
  raw: string;
}

export interface RobotsGroup {
  agents: string[];
  rules: RobotsRule[];
}

export interface RobotsTxt {
  groups: RobotsGroup[];
  sitemaps: string[];
  raw: string;
}

export function parseRobots(raw: string): RobotsTxt {
  const groups: RobotsGroup[] = [];
  const sitemaps: string[] = [];
  let current: RobotsGroup | null = null;
  let lastWasAgent = false;
  raw.split(/\r?\n/).forEach((lineRaw, idx) => {
    const line = lineRaw.replace(/#.*$/, '').trim();
    if (!line) return;
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) return;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      if (!current || !lastWasAgent) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(val.toLowerCase());
      lastWasAgent = true;
      return;
    }
    lastWasAgent = false;
    if (key === 'sitemap') {
      sitemaps.push(val);
      return;
    }
    if ((key === 'allow' || key === 'disallow') && current) {
      if (key === 'disallow' && val === '') return; // Disallow gol = totul permis
      current.rules.push({ allow: key === 'allow', path: val, line: idx + 1, raw: lineRaw.trim() });
    }
  });
  return { groups, sitemaps, raw };
}

function ruleMatches(pattern: string, path: string): boolean {
  let re = '^';
  for (const ch of pattern) {
    if (ch === '*') re += '.*';
    else if (ch === '$') re += '$';
    else re += ch.replace(/[.+?^{}()|[\]\\]/g, '\\$&');
  }
  try {
    return new RegExp(re).test(path);
  } catch {
    return path.startsWith(pattern);
  }
}

/** Grupul aplicabil unui UA: potrivirea cea mai specifică, altfel `*`. */
export function groupFor(robots: RobotsTxt, token: string): RobotsGroup[] {
  const t = token.toLowerCase();
  const specific = robots.groups.filter((g) => g.agents.some((a) => a !== '*' && (t === a || t.startsWith(a))));
  if (specific.length) return specific;
  return robots.groups.filter((g) => g.agents.includes('*'));
}

export function isAllowed(robots: RobotsTxt, token: string, path = '/'): { allowed: boolean; rule?: RobotsRule } {
  const groups = groupFor(robots, token);
  let best: RobotsRule | undefined;
  for (const g of groups) {
    for (const r of g.rules) {
      if (!ruleMatches(r.path, path)) continue;
      const len = r.path.replace(/\*/g, '').length;
      const bestLen = best ? best.path.replace(/\*/g, '').length : -1;
      if (len > bestLen || (len === bestLen && r.allow && !best?.allow)) best = r;
    }
  }
  return { allowed: best ? best.allow : true, rule: best };
}
