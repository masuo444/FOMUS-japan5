import { AI_SOURCE_GA_REGEX, detectAiSource } from './ai-sources'
import { BOT_KIND_JA, hasBotStore, readAiBotVisits, type BotKind, type BotVisit } from './ai-bots'
import { getGoogleAccessToken, hasGoogleCredentials } from './google-auth'

/**
 * 毎朝の「前日1日分」レポート。GA4（アクセス）・Search Console（検索ワード）・
 * AIクローラーの記録をまとめて管理者メール用のHTMLにする。
 * どれか1つが取れなくても、取れた分だけで送る。
 */

const GA4_PROPERTY = process.env.GA4_PROPERTY_ID || ''
export const GSC_SITE = 'sc-domain:fomus.jp'
const DAY_MS = 24 * 60 * 60 * 1000
const JST_OFFSET_MS = 9 * 60 * 60 * 1000

/** 日本時間の YYYY-MM-DD。offsetDays=-1 で昨日。 */
export function jstDate(offsetDays: number, base = Date.now()) {
  return new Date(base + JST_OFFSET_MS + offsetDays * DAY_MS).toISOString().slice(0, 10)
}

export function shiftDate(date: string, days: number) {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10)
}

// ---------- GA4 ----------

type GaRow = { dimensionValues?: { value: string }[]; metricValues?: { value: string }[] }
export type GaQuery = {
  dimensions?: string[]
  metrics: string[]
  limit?: number
  eventNames?: string[]
  /** 指定すると sessionSource がAIのセッションだけに絞る */
  aiOnly?: boolean
  /** 1日ではなく、この日数分さかのぼった期間で集計する */
  days?: number
}

export async function runGaReport(token: string, date: string, query: GaQuery) {
  const body: Record<string, unknown> = {
    dateRanges: [{ startDate: shiftDate(date, 1 - (query.days ?? 1)), endDate: date }],
    dimensions: (query.dimensions ?? []).map((name) => ({ name })),
    metrics: query.metrics.map((name) => ({ name })),
    limit: query.limit ?? 10,
  }
  if (query.metrics.length && query.dimensions?.length) {
    body.orderBys = [{ metric: { metricName: query.metrics[0] }, desc: true }]
  }
  const filters: Record<string, unknown>[] = []
  if (query.eventNames) {
    filters.push({ filter: { fieldName: 'eventName', inListFilter: { values: query.eventNames } } })
  }
  if (query.aiOnly) {
    filters.push({
      filter: {
        fieldName: 'sessionSource',
        stringFilter: { matchType: 'PARTIAL_REGEXP', value: AI_SOURCE_GA_REGEX, caseSensitive: false },
      },
    })
  }
  if (filters.length === 1) body.dimensionFilter = filters[0]
  if (filters.length > 1) body.dimensionFilter = { andGroup: { expressions: filters } }
  const response = await fetch(
    `https://analyticsdata.googleapis.com/v1beta/properties/${GA4_PROPERTY}:runReport`,
    {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
  )
  if (!response.ok) throw new Error(`GA4 ${response.status} ${await response.text()}`)
  const data = (await response.json()) as { rows?: GaRow[] }
  return (data.rows ?? []).map((row) => ({
    dims: (row.dimensionValues ?? []).map((v) => v.value),
    values: (row.metricValues ?? []).map((v) => Number(v.value)),
  }))
}

const SUMMARY_METRICS = [
  'activeUsers',
  'newUsers',
  'sessions',
  'screenPageViews',
  'engagedSessions',
  'averageSessionDuration',
]

async function fetchGa(date: string) {
  const token = await getGoogleAccessToken([
    'https://www.googleapis.com/auth/analytics.readonly',
  ])
  const summaryFor = async (d: string) =>
    (await runGaReport(token, d, { metrics: SUMMARY_METRICS }))[0]?.values ??
    SUMMARY_METRICS.map(() => 0)

  const [today, prevDay, lastWeek, channels, sources, landings, pages, devices, countries, actions, ctas] =
    await Promise.all([
      summaryFor(date),
      summaryFor(shiftDate(date, -1)),
      summaryFor(shiftDate(date, -7)),
      runGaReport(token, date, { dimensions: ['sessionDefaultChannelGroup'], metrics: ['sessions'] }),
      runGaReport(token, date, { dimensions: ['sessionSourceMedium'], metrics: ['sessions'], limit: 8 }),
      runGaReport(token, date, {
        dimensions: ['landingPagePlusQueryString'],
        metrics: ['sessions', 'engagedSessions'],
      }),
      runGaReport(token, date, {
        dimensions: ['pagePath'],
        metrics: ['screenPageViews', 'userEngagementDuration'],
      }),
      runGaReport(token, date, { dimensions: ['deviceCategory'], metrics: ['sessions'] }),
      runGaReport(token, date, { dimensions: ['country'], metrics: ['sessions'], limit: 6 }),
      runGaReport(token, date, {
        dimensions: ['eventName'],
        metrics: ['eventCount'],
        eventNames: ['generate_lead', 'inquiry_form_start', 'cta_click', 'contact_click'],
      }),
      runGaReport(token, date, {
        dimensions: ['linkText', 'linkUrl', 'pagePath'],
        metrics: ['eventCount'],
        eventNames: ['cta_click', 'contact_click'],
      }),
    ])
  const [aiSources, aiLandings, aiMonth, aiLeads] = await Promise.all([
    runGaReport(token, date, { dimensions: ['sessionSource'], metrics: ['sessions', 'engagedSessions'], aiOnly: true }),
    runGaReport(token, date, { dimensions: ['sessionSource', 'landingPagePlusQueryString'], metrics: ['sessions'], aiOnly: true }),
    runGaReport(token, date, { dimensions: ['sessionSource'], metrics: ['sessions'], aiOnly: true, days: 28 }),
    runGaReport(token, date, {
      dimensions: ['sessionSource'],
      metrics: ['eventCount'],
      eventNames: ['generate_lead'],
      aiOnly: true,
      days: 28,
    }),
  ])
  const ai = { aiSources, aiLandings, aiMonth, aiLeads }
  return { today, prevDay, lastWeek, channels, sources, landings, pages, devices, countries, actions, ctas, ai }
}

// ---------- Search Console ----------

async function fetchGsc(date: string) {
  const token = await getGoogleAccessToken([
    'https://www.googleapis.com/auth/webmasters.readonly',
  ])
  const query = async (dimensions: string[], rowLimit: number) => {
    const response = await fetch(
      `https://www.googleapis.com/webmasters/v3/sites/${encodeURIComponent(GSC_SITE)}/searchAnalytics/query`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ startDate: date, endDate: date, dimensions, rowLimit }),
      },
    )
    if (!response.ok) throw new Error(`GSC ${response.status} ${await response.text()}`)
    const data = (await response.json()) as {
      rows?: { keys?: string[]; clicks: number; impressions: number; position: number }[]
    }
    return data.rows ?? []
  }
  const [totals, queries] = await Promise.all([query([], 1), query(['query'], 15)])
  return { totals: totals[0], queries }
}

// ---------- HTML ----------

export function esc(value: unknown) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

const num = (n: number) => Math.round(n).toLocaleString('ja-JP')

function diff(current: number, base: number) {
  if (!base) return current ? '<span style="color:#888;">（比較なし）</span>' : ''
  const pct = Math.round(((current - base) / base) * 100)
  const color = pct > 0 ? '#2e7d32' : pct < 0 ? '#c62828' : '#888'
  return `<span style="color:${color};">${pct > 0 ? '+' : ''}${pct}%</span>`
}

function seconds(n: number) {
  const s = Math.round(n)
  return s >= 60 ? `${Math.floor(s / 60)}分${s % 60}秒` : `${s}秒`
}

const th = 'text-align:left;padding:6px 8px;border-bottom:1px solid #ddd;color:#888;font-weight:normal;font-size:12px;'
const td = 'padding:6px 8px;border-bottom:1px solid #f0f0f0;vertical-align:top;'
const tdNum = `${td}text-align:right;white-space:nowrap;`

function table(headers: string[], rows: (string | number)[][], numericFrom = 1) {
  if (!rows.length) return '<p style="color:#888;font-size:13px;">データなし</p>'
  return `<table style="width:100%;border-collapse:collapse;font-size:13px;">
<tr>${headers.map((h, i) => `<th style="${th}${i >= numericFrom ? 'text-align:right;' : ''}">${h}</th>`).join('')}</tr>
${rows
  .map(
    (row) =>
      `<tr>${row.map((cell, i) => `<td style="${i >= numericFrom ? tdNum : td}">${cell}</td>`).join('')}</tr>`,
  )
  .join('\n')}
</table>`
}

const section = (title: string, body: string) =>
  `<h2 style="font-size:15px;margin:28px 0 8px;padding-bottom:4px;border-bottom:2px solid #7a5c2e;">${title}</h2>${body}`

const CHANNEL_JA: Record<string, string> = {
  'Organic Search': '自然検索',
  Direct: '直接',
  Referral: '他サイトのリンク',
  'Organic Social': 'SNS',
  'Paid Search': '検索広告',
  'Paid Social': 'SNS広告',
  Email: 'メール',
  Unassigned: '不明',
}
/** 参照元URLを「Google検索」のような短い名前にする */
function describeReferrer(referrer?: string) {
  if (!referrer) return '直接 / 不明'
  const ai = detectAiSource(referrer)
  if (ai) return ai
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '')
    if (/(^|\.)google\./.test(host)) return 'Google検索'
    if (/(^|\.)yahoo\./.test(host)) return 'Yahoo!検索'
    if (/bing\.com$/.test(host)) return 'Bing検索'
    if (/instagram\.com$/.test(host)) return 'Instagram'
    if (/facebook\.com$/.test(host)) return 'Facebook'
    if (/(^|\.)(x|twitter|t)\.(com|co)$/.test(host)) return 'X'
    return host
  } catch {
    return referrer
  }
}

const pageLabel = (path: string) => (path === '/' ? 'トップページ（/）' : path)

function sumBy(visits: BotVisit[], key: (v: BotVisit) => string) {
  const totals = new Map<string, number>()
  for (const v of visits) totals.set(key(v), (totals.get(key(v)) ?? 0) + v.count)
  return [...totals.entries()].sort((a, b) => b[1] - a[1])
}

function renderBotSection(day: BotVisit[], month: BotVisit[]) {
  const kinds: BotKind[] = ['answer', 'search', 'training']
  const countOf = (visits: BotVisit[], kind: BotKind) =>
    visits.filter((v) => v.kind === kind).reduce((sum, v) => sum + v.count, 0)
  const answerDay = day.filter((v) => v.kind === 'answer')
  const answerMonth = month.filter((v) => v.kind === 'answer')
  return (
    `<p style="font-size:12px;color:#888;margin:0 0 8px;">人ではなく、AIのプログラムがページを読みに来た回数。「質問に答えるために読みに来た」は、誰かがAIに質問し、AIがその答えを作るためにこのサイトを開いたもの（AIに紹介されている度合いの目安）。</p>` +
    table(
      ['種類', '昨日', '直近28日'],
      kinds.map((kind) => [BOT_KIND_JA[kind], num(countOf(day, kind)), num(countOf(month, kind))]),
    ) +
    '<p style="font-size:12px;color:#888;margin:12px 0 4px;">質問に答えるために読まれたページ（直近28日）</p>' +
    (answerMonth.length
      ? table(
          ['ページ', '昨日', '28日'],
          sumBy(answerMonth, (v) => v.path)
            .slice(0, 15)
            .map(([path, count]) => [
              esc(pageLabel(path)),
              num(answerDay.filter((v) => v.path === path).reduce((sum, v) => sum + v.count, 0)),
              num(count),
            ]),
        )
      : '<p style="color:#888;font-size:13px;">まだ記録はありません。</p>') +
    '<p style="font-size:12px;color:#888;margin:12px 0 4px;">AI別（直近28日）</p>' +
    table(
      ['AI', '回数'],
      sumBy(month, (v) => v.bot)
        .slice(0, 12)
        .map(([bot, count]) => [esc(bot), num(count)]),
    )
  )
}

const DEVICE_JA: Record<string, string> = { mobile: 'スマホ', desktop: 'PC', tablet: 'タブレット' }
const EVENT_JA: Record<string, string> = {
  generate_lead: '見積り・問い合わせの送信',
  inquiry_form_start: 'フォームに入力し始めた',
  cta_click: '見積り・相談ボタンのクリック',
  contact_click: 'メール・電話・LINEのクリック',
}

export async function buildDailyReport(date: string) {
  const notes: string[] = []
  const gscDate = shiftDate(date, -2) // Search Console は2〜3日遅れて確定する

  const botDates = Array.from({ length: 28 }, (_, i) => shiftDate(date, -i))
  const [ga, gsc, botDays] = await Promise.all([
    hasGoogleCredentials()
      ? fetchGa(date).catch((error) => {
          notes.push(`アクセス解析（GA4）を取得できませんでした: ${String(error).slice(0, 200)}`)
          return null
        })
      : (notes.push('GOOGLE_SA_JSON が未設定のため、アクセス数・検索ワードは載せていません。'), null),
    hasGoogleCredentials()
      ? fetchGsc(gscDate).catch((error) => {
          notes.push(`検索ワード（Search Console）を取得できませんでした: ${String(error).slice(0, 200)}`)
          return null
        })
      : null,
    hasBotStore()
      ? readAiBotVisits(botDates).catch((error) => {
          notes.push(`AIの閲覧記録を読めませんでした: ${String(error).slice(0, 200)}`)
          return null
        })
      : null,
  ])

  const parts: string[] = []

  if (ga) {
    const labels = ['訪問者', 'うち初めての人', '訪問（セッション）', 'ページ表示', 'しっかり見た訪問', '1訪問の平均時間']
    parts.push(
      section(
        'アクセス',
        table(
          ['', '昨日', '前日比', '先週同曜日比'],
          labels.map((label, i) => [
            label,
            i === 5 ? seconds(ga.today[i]) : num(ga.today[i]),
            diff(ga.today[i], ga.prevDay[i]),
            diff(ga.today[i], ga.lastWeek[i]),
          ]),
        ),
      ),
    )
    const sessions = ga.today[2] || 1
    parts.push(
      section(
        'どこから来たか',
        table(
          ['経路', '訪問', '割合'],
          ga.channels.map((r) => [
            esc(CHANNEL_JA[r.dims[0]] ?? r.dims[0]),
            num(r.values[0]),
            `${Math.round((r.values[0] / sessions) * 100)}%`,
          ]),
        ) +
          '<p style="font-size:12px;color:#888;margin:12px 0 4px;">参照元の内訳</p>' +
          table(['参照元 / 種類', '訪問'], ga.sources.map((r) => [esc(r.dims[0]), num(r.values[0])])),
      ),
    )
    const aiName = (source: string) => detectAiSource(source) || source
    const aiTotal = ga.ai.aiSources.reduce((sum, r) => sum + r.values[0], 0)
    const aiMonthTotal = ga.ai.aiMonth.reduce((sum, r) => sum + r.values[0], 0)
    const aiMonthLeads = ga.ai.aiLeads.reduce((sum, r) => sum + r.values[0], 0)
    parts.push(
      section(
        `AIから来た訪問 ${num(aiTotal)}件`,
        `<p style="font-size:12px;color:#888;margin:0 0 8px;">ChatGPT・Perplexity・Gemini などで紹介されて来た人。直近28日の合計：${num(aiMonthTotal)}訪問 / 問い合わせ${num(aiMonthLeads)}件（Googleの「AIによる概要」経由は通常の検索と区別できないため含まない）</p>` +
          (ga.ai.aiSources.length
            ? table(
                ['AI', '訪問', 'しっかり見た'],
                ga.ai.aiSources.map((r) => [esc(aiName(r.dims[0])), num(r.values[0]), num(r.values[1])]),
              ) +
              '<p style="font-size:12px;color:#888;margin:12px 0 4px;">AIから入ったページ</p>' +
              table(
                ['ページ', '訪問'],
                ga.ai.aiLandings.map((r) => [
                  `${esc(r.dims[1])}<br><span style="color:#888;font-size:12px;">${esc(aiName(r.dims[0]))}</span>`,
                  num(r.values[0]),
                ]),
              )
            : '') +
          (ga.ai.aiMonth.length
            ? '<p style="font-size:12px;color:#888;margin:12px 0 4px;">直近28日のAI別</p>' +
              table(
                ['AI', '訪問'],
                ga.ai.aiMonth.map((r) => [esc(aiName(r.dims[0])), num(r.values[0])]),
              )
            : ''),
      ),
    )
    parts.push(
      section(
        '入口になったページ',
        table(
          ['ページ', '訪問', 'しっかり見た'],
          ga.landings.map((r) => [esc(r.dims[0]), num(r.values[0]), num(r.values[1])]),
        ),
      ),
    )
    parts.push(
      section(
        'よく見られたページ',
        table(
          ['ページ', '表示', '合計の滞在'],
          ga.pages.map((r) => [esc(r.dims[0]), num(r.values[0]), seconds(r.values[1])]),
        ),
      ),
    )
    parts.push(
      section(
        '見た人の端末と国',
        table(['端末', '訪問'], ga.devices.map((r) => [esc(DEVICE_JA[r.dims[0]] ?? r.dims[0]), num(r.values[0])])) +
          '<div style="height:8px;"></div>' +
          table(['国', '訪問'], ga.countries.map((r) => [esc(r.dims[0]), num(r.values[0])])),
      ),
    )
    const actionCount = (name: string) => ga.actions.find((r) => r.dims[0] === name)?.values[0] ?? 0
    parts.push(
      section(
        '問い合わせにつながる行動',
        table(
          ['行動', '回数'],
          Object.keys(EVENT_JA).map((name) => [EVENT_JA[name], num(actionCount(name))]),
        ) +
          (ga.ctas.length
            ? '<p style="font-size:12px;color:#888;margin:12px 0 4px;">押されたボタン</p>' +
              table(
                ['ボタン', '回数'],
                ga.ctas.map((r) => [
                  `${esc(r.dims[0])}<br><span style="color:#888;font-size:12px;">${esc(pageLabel(r.dims[2]))} → ${esc(r.dims[1])}</span>`,
                  num(r.values[0]),
                ]),
              )
            : ''),
      ),
    )
  }

  if (botDays) {
    parts.push(section('AIが読みに来たページ', renderBotSection(botDays[0], botDays.flat())))
  }

  if (gsc) {
    const t = gsc.totals
    parts.push(
      section(
        `Googleで検索された言葉（${gscDate.slice(5).replace('-', '/')}分）`,
        `<p style="font-size:12px;color:#888;margin:0 0 8px;">Search Consoleは2〜3日遅れで確定するため、この欄だけ少し前の日の数字です。${
          t ? `合計：表示 ${num(t.impressions)}回 / クリック ${num(t.clicks)}回 / 平均 ${t.position.toFixed(1)}位` : ''
        }</p>` +
          table(
            ['検索ワード', '表示', 'クリック', '平均順位'],
            gsc.queries.map((r) => [
              esc(r.keys?.[0]),
              num(r.impressions),
              num(r.clicks),
              r.position.toFixed(1),
            ]),
          ),
      ),
    )
  }

  if (notes.length) {
    parts.push(
      `<div style="margin-top:28px;padding:12px;background:#fff8e1;font-size:12px;color:#795548;">${notes
        .map(esc)
        .join('<br>')}</div>`,
    )
  }

  const leads = ga?.actions.find((r) => r.dims[0] === 'generate_lead')?.values[0]
  const visitors = ga?.today[0]
  const subject = `【FOMUS 日報】${date.slice(5).replace('-', '/')} ${
    visitors != null ? `訪問者${num(visitors)}人` : ''
  }${leads != null ? ` / 問い合わせ${leads}件` : ''}`.trim()

  const html = `<div style="font-family:-apple-system,'Hiragino Sans',sans-serif;max-width:680px;margin:0 auto;padding:20px;color:#222;">
<p style="font-size:12px;color:#888;margin:0;">www.fomus.jp の ${esc(date)}（日本時間）1日分。問い合わせの中身と経路は contact@fomus.jp に届くフォームのメールを見てください。</p>
${parts.join('\n')}
</div>`

  return { subject, html }
}
