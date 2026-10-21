/**
 * Microsoft Clarity のデータ取得（直近24時間・ページ別）。
 * API はプロジェクトごとに1日10回まで。日報で1回だけ呼ぶ。
 */

export const CLARITY_PROJECT_ID = 'z121yv253w'

export const hasClarityToken = () => Boolean(process.env.CLARITY_API_TOKEN)

type ClarityInfo = Record<string, string | number | null | undefined>
type ClarityMetric = { metricName: string; information?: ClarityInfo[] }

export type ClarityPage = {
  url: string
  sessions: number
  scrollDepth?: number
  deadClicks: number
  rageClicks: number
  quickBacks: number
}

const n = (v: unknown) => Number(v ?? 0) || 0

export async function fetchClarity(): Promise<ClarityPage[]> {
  const response = await fetch(
    'https://www.clarity.ms/export-data/api/v1/project-live-insights?numOfDays=1&dimension1=URL',
    { headers: { Authorization: `Bearer ${process.env.CLARITY_API_TOKEN}`, 'Content-Type': 'application/json' } },
  )
  if (!response.ok) throw new Error(`Clarity ${response.status} ${await response.text()}`)
  const metrics = (await response.json()) as ClarityMetric[]

  const pages = new Map<string, ClarityPage>()
  const pageOf = (info: ClarityInfo) => {
    const url = String(info.Url ?? info.URL ?? '').replace(/^https?:\/\/(www\.)?fomus\.jp/, '') || '/'
    let page = pages.get(url)
    if (!page) {
      page = { url, sessions: 0, deadClicks: 0, rageClicks: 0, quickBacks: 0 }
      pages.set(url, page)
    }
    return page
  }
  for (const metric of metrics) {
    for (const info of metric.information ?? []) {
      const page = pageOf(info)
      switch (metric.metricName) {
        case 'Traffic':
          page.sessions = n(info.totalSessionCount)
          break
        case 'ScrollDepth':
          page.scrollDepth = n(info.averageScrollDepth)
          break
        case 'DeadClickCount':
          page.deadClicks = n(info.subTotal)
          break
        case 'RageClickCount':
          page.rageClicks = n(info.subTotal)
          break
        case 'QuickbackClick':
          page.quickBacks = n(info.subTotal)
          break
      }
    }
  }
  return [...pages.values()].filter((p) => p.sessions > 0).sort((a, b) => b.sessions - a.sessions)
}
