/*
 * AIのクローラー・AIアシスタントがどのページを読みに来たかを日別に数える（Vercel Routing Middleware）。
 * 人の訪問では何もしない。記録先は MASU-STORE と共有の Upstash Redis（キーは fomus:aibot:日付）。
 */
const AI_BOTS = [
  ['ChatGPT-User', /ChatGPT-User/i], ['Perplexity-User', /Perplexity-User/i], ['Claude-User', /Claude-User/i],
  ['MistralAI-User', /MistralAI-User/i], ['DuckAssistBot', /DuckAssistBot/i],
  ['OAI-SearchBot', /OAI-SearchBot/i], ['PerplexityBot', /PerplexityBot/i], ['Claude-SearchBot', /Claude-SearchBot/i],
  ['Googlebot', /Googlebot/i], ['Bingbot', /bingbot/i], ['Applebot', /Applebot/i],
  ['GPTBot', /GPTBot/i], ['ClaudeBot', /ClaudeBot|anthropic-ai/i], ['Meta AI', /meta-externalagent|meta-externalfetcher/i],
  ['Amazonbot', /Amazonbot/i], ['Bytespider', /Bytespider/i], ['CCBot', /CCBot/i], ['cohere-ai', /cohere-ai/i],
]
// 実在しそうなパスだけ数える（ボットを名乗った偽アクセスで記録を水増しされないように）
const RECORDABLE_PATH = /^\/(?:[A-Za-z0-9_-]+\/){0,3}(?:[A-Za-z0-9_-]+\.html)?$|^\/(?:llms|llms-full|robots)\.txt$|^\/sitemap\.xml$/

export const config = {
  matcher: ['/((?!api/|.*\\.(?:png|jpe?g|webp|gif|svg|ico|mp4|mov|MP4|JPG|css|js|woff2?|pdf)$).*)'],
}

export default async function middleware(request) {
  const ua = request.headers.get('user-agent') || ''
  const bot = AI_BOTS.find(([, pattern]) => pattern.test(ua))
  if (!bot) return
  const path = new URL(request.url).pathname
  const url = process.env.KV_REST_API_URL
  const token = process.env.KV_REST_API_TOKEN
  if (!url || !token || !RECORDABLE_PATH.test(path)) return
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const key = `fomus:aibot:${date}`
  try {
    await fetch(`${url}/pipeline`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify([['HINCRBY', key, `${bot[0]}\t${path.slice(0, 300)}`, 1], ['EXPIRE', key, 7776000]]),
    })
  } catch (e) {
    // 記録の失敗でページ表示を止めない
  }
}
