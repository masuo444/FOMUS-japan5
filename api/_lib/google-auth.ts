import { createSign } from 'node:crypto'

/**
 * サービスアカウントの鍵（環境変数 GOOGLE_SA_JSON に JSON 丸ごと）から
 * Google API のアクセストークンを取る。googleapis を入れずに済ませるための最小実装。
 */

type ServiceAccount = { client_email: string; private_key: string }

function base64url(input: string | Buffer) {
  return Buffer.from(input).toString('base64url')
}

export function hasGoogleCredentials() {
  return Boolean(process.env.GOOGLE_SA_JSON)
}

export async function getGoogleAccessToken(scopes: string[]) {
  const raw = process.env.GOOGLE_SA_JSON
  if (!raw) throw new Error('GOOGLE_SA_JSON is not set')
  const account = JSON.parse(raw) as ServiceAccount

  const now = Math.floor(Date.now() / 1000)
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }))
  const claims = base64url(
    JSON.stringify({
      iss: account.client_email,
      scope: scopes.join(' '),
      aud: 'https://oauth2.googleapis.com/token',
      iat: now,
      exp: now + 3600,
    }),
  )
  const signer = createSign('RSA-SHA256')
  signer.update(`${header}.${claims}`)
  const signature = signer.sign(account.private_key).toString('base64url')

  const response = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: `${header}.${claims}.${signature}`,
    }),
  })
  if (!response.ok) {
    throw new Error(`Google token request failed: ${response.status} ${await response.text()}`)
  }
  const data = (await response.json()) as { access_token: string }
  return data.access_token
}
