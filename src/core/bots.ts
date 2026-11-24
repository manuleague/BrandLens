// Crawlerele AI și de căutare relevante pentru GEO (verificați periodic listele oficiale ale furnizorilor).

export interface BotDef {
  token: string; // token robots.txt
  operator: string;
  purpose: 'search' | 'user' | 'training';
  feeds: string; // ce produs alimentează
  ua: string; // user-agent folosit la testul live
  critical: boolean; // dacă blocarea lui scoate brandul din răspunsuri
}

export const BOTS: BotDef[] = [
  { token: 'OAI-SearchBot', operator: 'OpenAI', purpose: 'search', feeds: 'ChatGPT Search', critical: true,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; OAI-SearchBot/1.4; +https://openai.com/searchbot' },
  { token: 'ChatGPT-User', operator: 'OpenAI', purpose: 'user', feeds: 'ChatGPT (vizite la cererea utilizatorului)', critical: false,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot' },
  { token: 'GPTBot', operator: 'OpenAI', purpose: 'training', feeds: 'Antrenare modele OpenAI', critical: false,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; GPTBot/1.3; +https://openai.com/gptbot' },
  { token: 'Claude-SearchBot', operator: 'Anthropic', purpose: 'search', feeds: 'Căutarea web din Claude', critical: true,
    ua: 'Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)' },
  { token: 'Claude-User', operator: 'Anthropic', purpose: 'user', feeds: 'Claude (vizite la cererea utilizatorului)', critical: false,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Claude-User/1.0; +Claude-User@anthropic.com)' },
  { token: 'ClaudeBot', operator: 'Anthropic', purpose: 'training', feeds: 'Antrenare modele Anthropic', critical: false,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)' },
  { token: 'PerplexityBot', operator: 'Perplexity', purpose: 'search', feeds: 'Indexul Perplexity', critical: true,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)' },
  { token: 'Perplexity-User', operator: 'Perplexity', purpose: 'user', feeds: 'Perplexity (vizite la cererea utilizatorului)', critical: false,
    ua: 'Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)' },
  { token: 'Googlebot', operator: 'Google', purpose: 'search', feeds: 'Google Search, AI Overviews, AI Mode, grounding Gemini', critical: true,
    ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' },
  { token: 'Google-Extended', operator: 'Google', purpose: 'training', feeds: 'Antrenare/grounding Gemini (nu afectează Search)', critical: false,
    ua: 'Mozilla/5.0 (compatible; Google-Extended)' },
  { token: 'Bingbot', operator: 'Microsoft', purpose: 'search', feeds: 'Bing, Copilot și o parte din sursele ChatGPT', critical: true,
    ua: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)' },
  { token: 'Applebot', operator: 'Apple', purpose: 'search', feeds: 'Siri / Spotlight / Apple Maps', critical: false,
    ua: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15 (Applebot/0.1)' },
  { token: 'Applebot-Extended', operator: 'Apple', purpose: 'training', feeds: 'Apple Intelligence (antrenare)', critical: false,
    ua: 'Mozilla/5.0 (compatible; Applebot-Extended/0.1)' },
  { token: 'meta-externalagent', operator: 'Meta', purpose: 'training', feeds: 'Meta AI', critical: false,
    ua: 'meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)' },
  { token: 'DuckAssistBot', operator: 'DuckDuckGo', purpose: 'search', feeds: 'DuckDuckGo AI answers', critical: false,
    ua: 'DuckAssistBot/1.2; (+http://duckduckgo.com/duckassistbot.html)' },
  { token: 'CCBot', operator: 'Common Crawl', purpose: 'training', feeds: 'Set de date deschis folosit de mulți furnizori', critical: false,
    ua: 'CCBot/2.0 (https://commoncrawl.org/faq/)' },
];

/** Referreri AI pentru segmentul/canalul GA4. */
export const AI_REFERRER_REGEX =
  '(chatgpt\\.com|chat\\.openai\\.com|openai|perplexity|claude\\.ai|anthropic|gemini\\.google|bard\\.google|copilot\\.microsoft|edgeservices|bing\\.com/chat|grok|x\\.ai|deepseek|meta\\.ai|mistral|you\\.com|phind)';
