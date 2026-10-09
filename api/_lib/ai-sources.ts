/**
 * ChatGPT などの AI アシスタント経由の流入を見分ける。
 * 参照元URL・utm_source（ChatGPTはリンクに utm_source=chatgpt.com を付ける）・GA4のセッション参照元に使う。
 * Google の AI による概要（AI Overviews）は通常の Google 検索と区別できないため含まない。
 */

export const AI_SOURCES: { name: string; pattern: RegExp }[] = [
  { name: 'ChatGPT', pattern: /chatgpt\.com|chat\.openai\.com|openai/ },
  { name: 'Perplexity', pattern: /perplexity/ },
  { name: 'Gemini', pattern: /gemini\.google|bard\.google/ },
  { name: 'Copilot', pattern: /copilot\.microsoft|copilot\.cloud\.microsoft|edgeservices\.bing/ },
  { name: 'Claude', pattern: /claude\.ai|anthropic/ },
  { name: 'Grok', pattern: /grok\.com|x\.ai\b/ },
  { name: 'DeepSeek', pattern: /deepseek/ },
  { name: 'Meta AI', pattern: /meta\.ai/ },
  { name: 'Genspark', pattern: /genspark/ },
  { name: 'Felo', pattern: /felo\.ai/ },
  { name: 'You.com', pattern: /you\.com/ },
  { name: 'Poe', pattern: /poe\.com/ },
  { name: 'Mistral', pattern: /chat\.mistral|mistral\.ai/ },
]

/** GA4 の sessionSource に部分一致させる正規表現（RE2互換） */
export const AI_SOURCE_GA_REGEX = AI_SOURCES.map((s) => s.pattern.source).join('|')

/** 渡した文字列（参照元・入口URL・utm_source）のどれかがAIなら、そのAIの名前を返す */
export function detectAiSource(...values: (string | undefined)[]) {
  for (const raw of values) {
    if (!raw) continue
    const value = raw.toLowerCase()
    const hit = AI_SOURCES.find((s) => s.pattern.test(value))
    if (hit) return hit.name
  }
  return ''
}
