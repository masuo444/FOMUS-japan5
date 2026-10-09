import { isCronAuthorized } from '../_lib/cron-auth'
import { buildDailyReport, jstDate } from '../_lib/daily-report'

/** 毎朝8時（日本時間）に Vercel Cron から呼ばれ、前日1日分のレポートを管理者へメールする */
export async function GET(request: Request) {
  if (!isCronAuthorized(request)) return Response.json({ error: 'unauthorized' }, { status: 401 })
  const resendApiKey = process.env.RESEND_API_KEY
  const adminEmail = process.env.ADMIN_EMAIL
  if (!resendApiKey || !adminEmail) return Response.json({ error: 'email is not configured' }, { status: 503 })

  const date = jstDate(-1)
  const report = await buildDailyReport(date)
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${resendApiKey}` },
    body: JSON.stringify({ from: 'contact@fomus.jp', to: adminEmail, subject: report.subject, html: report.html }),
  })
  if (!response.ok) {
    console.error('Daily report email failed', response.status, await response.text())
    return Response.json({ error: 'email failed' }, { status: 502 })
  }
  return Response.json({ ok: true, date, subject: report.subject })
}
