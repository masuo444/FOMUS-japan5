import { isCronAuthorized } from '../_lib/cron-auth'
import { jstDate } from '../_lib/daily-report'
import { buildMonthlyAdvice } from '../_lib/monthly-advice'

/** 毎月1日9時（日本時間）に Vercel Cron から呼ばれ、直近30日の改善アドバイスを管理者へメールする（Claude API を1回呼ぶ） */
export const config = { maxDuration: 300 }

export async function GET(request: Request) {
  if (!isCronAuthorized(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const resendApiKey = process.env.RESEND_API_KEY
  const adminEmail = process.env.ADMIN_EMAIL
  if (!resendApiKey || !adminEmail) return Response.json({ error: 'email is not configured' }, { status: 503 })

  const date = jstDate(-1)
  let report: { subject: string; html: string }
  try {
    report = await buildMonthlyAdvice(date)
  } catch (error) {
    console.error('Monthly advice failed', error)
    report = {
      subject: '【FOMUS 月次アドバイス】作成できませんでした',
      html: `<p>今月の改善アドバイスを作れませんでした。</p><pre style="white-space:pre-wrap;font-size:12px;color:#888;">${String(error).slice(0, 500).replaceAll('<', '&lt;')}</pre>`,
    }
  }
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
    body: JSON.stringify({ from: 'contact@fomus.jp', to: adminEmail, subject: report.subject, html: report.html }),
  })
  if (!response.ok) {
    console.error('Monthly advice email failed', response.status, await response.text())
    return Response.json({ error: 'email failed' }, { status: 502 })
  }
  return Response.json({ ok: true, date, subject: report.subject })
}
