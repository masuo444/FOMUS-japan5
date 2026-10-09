/**
 * AIのクローラー・AIアシスタントがどのページを読みに来たかを日別に数える（AIO/AEOの効果測定）。
 * 保存先は Upstash Redis（Vercel Marketplace 経由・無料枠）。環境変数が無ければ何もしない。
 * キー: aibot:YYYY-MM-DD（日本時間）／フィールド: "ボット名\tパス"／値: 回数。90日で消える。
 */

export type BotKind = 'answer' | 'search' | 'training'

export const AI_BOTS: { name: string; pattern: RegExp; kind: BotKind }[] = [
  // 利用者の質問に答えるために、その場でページを読みに来たもの（いちばん価値が高い）
  { name: 'ChatGPT-User', pattern: /ChatGPT-User/i, kind: 'answer' },
  { name: 'Perplexity-User', pattern: /Perplexity-User/i, kind: 'answer' },
  { name: 'Claude-User', pattern: /Claude-User/i, kind: 'answer' },
  { name: 'MistralAI-User', pattern: /MistralAI-User/i, kind: 'answer' },
  { name: 'DuckAssistBot', pattern: /DuckAssistBot/i, kind: 'answer' },
  // AI検索・検索エンジンの索引づくり
  { name: 'OAI-SearchBot', pattern: /OAI-SearchBot/i, kind: 'search' },
  { name: 'PerplexityBot', pattern: /PerplexityBot/i, kind: 'search' },
  { name: 'Claude-SearchBot', pattern: /Claude-SearchBot/i, kind: 'search' },
  { name: 'Googlebot', pattern: /Googlebot/i, kind: 'search' },
  { name: 'Bingbot', pattern: /bingbot/i, kind: 'search' },
  { name: 'Applebot', pattern: /Applebot/i, kind: 'search' },
  // AIの学習用の収集
  { name: 'GPTBot', pattern: /GPTBot/i, kind: 'training' },
  { name: 'ClaudeBot', pattern: /ClaudeBot|anthropic-ai/i, kind: 'training' },
  { name: 'Meta AI', pattern: /meta-externalagent|meta-externalfetcher/i, kind: 'training' },
  { name: 'Amazonbot', pattern: /Amazonbot/i, kind: 'training' },
  { name: 'Bytespider', pattern: /Bytespider/i, kind: 'training' },
  { name: 'CCBot', pattern: /CCBot/i, kind: 'training' },
  { name: 'cohere-ai', pattern: /cohere-ai/i, kind: 'training' },
]

export const BOT_KIND_JA: Record<BotKind, string> = {
  answer: '質問に答えるために読みに来た',
  search: 'AI検索・検索エンジンの収集',
  training: 'AIの学習用の収集',
}

const RETENTION_SEC = 90 * 24 * 60 * 60

export function detectAiBot(userAgent: string) {
  if (!userAgent) return null
  return AI_BOTS.find((bot) => bot.pattern.test(userAgent)) ?? null
}

function redisConfig() {
  const url = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL
  const token = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN
  return url && token ? { url, token } : null
}

export function hasBotStore() {
  return Boolean(redisConfig())
}

async function pipeline(commands: (string | number)[][]) {
  const config = redisConfig()
  if (!config) return null
  const response = await fetch(`${config.url}/pipeline`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(commands),
    cache: 'no-store',
  })
  if (!response.ok) throw new Error(`Redis ${response.status} ${await response.text()}`)
  return (await response.json()) as { result: unknown }[]
}

// MASU-STORE と同じ置き場を共有するので、キーの先頭に fomus: を付けて分ける
const keyFor = (date: string) => `fomus:aibot:${date}`

/** 1回の閲覧を記録する。失敗してもページ表示には影響させない */
export async function recordAiBotVisit(botName: string, path: string) {
  const date = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const key = keyFor(date)
  try {
    await pipeline([
      ['HINCRBY', key, `${botName}\t${path.slice(0, 300)}`, 1],
      ['EXPIRE', key, RETENTION_SEC],
    ])
  } catch (error) {
    console.error('AI bot record failed', error)
  }
}

export type BotVisit = { bot: string; kind: BotKind; path: string; count: number }

/** 指定した日付（日本時間 YYYY-MM-DD）それぞれの記録を返す */
export async function readAiBotVisits(dates: string[]) {
  const results = await pipeline(dates.map((date) => ['HGETALL', keyFor(date)]))
  if (!results) return null
  return results.map((entry) => {
    // Upstash の REST は HGETALL を [field, value, field, value, ...] で返す
    const flat = (entry.result as string[] | null) ?? []
    const visits: BotVisit[] = []
    for (let i = 0; i < flat.length; i += 2) {
      const [bot, path] = flat[i].split('\t')
      const kind = AI_BOTS.find((b) => b.name === bot)?.kind ?? 'training'
      visits.push({ bot, kind, path, count: Number(flat[i + 1]) })
    }
    return visits
  })
}
