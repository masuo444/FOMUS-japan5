import { timingSafeEqual } from 'node:crypto'

/** Vercel Cron からの呼び出しか（Authorization: Bearer CRON_SECRET）を、応答時間で推測されない形で確かめる */
export function isCronAuthorized(request: Request) {
  const secret = process.env.CRON_SECRET
  if (!secret) return false
  const given = Buffer.from(request.headers.get('authorization') ?? '')
  const expected = Buffer.from(`Bearer ${secret}`)
  return given.length === expected.length && timingSafeEqual(given, expected)
}
