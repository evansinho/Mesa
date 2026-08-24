import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, timingSafeEqual } from 'crypto'
import { and, eq, gt } from 'drizzle-orm'
import { authSessions, type Db } from '@mesa/db'
import { config } from '@mesa/config'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export type ApiAuth =
  | { kind: 'internal' }
  | { kind: 'session'; merchantId: string }

declare module 'fastify' {
  interface FastifyRequest {
    auth?: ApiAuth
  }
}

function isPublicRoute(path: string, method: string): boolean {
  if (path === '/health' || path === '/ready') return true
  if (path === '/auth/request' || path === '/auth/verify') return true
  // Meta-called callbacks (data deletion / deauthorize) — Meta never sends
  // an API key or session token, these are their own credential-free
  // requirement. /auth/data-deletion was previously missing here, meaning
  // Meta could never actually reach it despite the route existing.
  if (path === '/auth/data-deletion' || path === '/auth/deauthorize') return true
  if (path === '/merchants' && method === 'POST') return true
  if (path === '/webhooks/paystack' && method === 'POST') return true
  if (path === '/webhooks/mono' && method === 'POST') return true
  if (path === '/webhooks/fez' && method === 'POST') return true
  // Action routes are token-authenticated — the signed token in the URL is the credential
  if (path.startsWith('/actions/')) return true
  // Tracking-link redirects are opened directly by a customer's phone browser
  // after tapping a merchant's bio link — no credential exists to send.
  if (path.startsWith('/l/') && method === 'GET') return true
  return false
}

// Routes that enforce their own auth *inside* the handler instead of the
// blanket 401 below — the hook still populates req.auth from headers when
// present, but doesn't reject a request that arrives with none. Used only
// for the platform Instagram bootstrap: the very first connect is opened
// directly in a browser (no merchant session, no way to attach the internal
// API key header), but once bootstrapped the handler requires `internal`
// auth for any reconnect — see connect-platform-account in routes/instagram.ts.
function isCredentialOptionalRoute(path: string, method: string): boolean {
  if (path === '/instagram/connect-platform-account' && method === 'POST') return true
  return false
}

export function registerAuthContext(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (isPublicRoute(path, req.method)) return

    const apiKey = req.headers['x-mesa-api-key']
    if (typeof apiKey === 'string' && safeEqual(apiKey, config.INTERNAL_API_KEY)) {
      req.auth = { kind: 'internal' }
      return
    }

    const authHeader = req.headers.authorization
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.slice(7)
      const tokenHash = createHash('sha256').update(token).digest('hex')
      const session = await db.query.authSessions.findFirst({
        where: and(
          eq(authSessions.sessionHash, tokenHash),
          gt(authSessions.expiresAt, new Date()),
        ),
      })
      if (session) {
        req.auth = { kind: 'session', merchantId: session.merchantId }
        return
      }
    }

    if (isCredentialOptionalRoute(path, req.method)) return

    return reply.status(401).send({ error: 'Unauthorized' })
  })
}

export type MerchantAuthorization =
  | { ok: true; merchantId?: string }
  | { ok: false }

export function authorizeMerchant(
  req: FastifyRequest,
  reply: FastifyReply,
  requestedMerchantId?: string,
  options: { allowInternalWithoutMerchant?: boolean } = {},
): MerchantAuthorization {
  if (!req.auth) {
    reply.status(401).send({ error: 'Unauthorized' })
    return { ok: false }
  }

  if (req.auth.kind === 'internal') {
    if (requestedMerchantId) return { ok: true, merchantId: requestedMerchantId }
    if (options.allowInternalWithoutMerchant) return { ok: true }
    reply.status(400).send({ error: 'merchantId required' })
    return { ok: false }
  }

  if (requestedMerchantId && requestedMerchantId !== req.auth.merchantId) {
    reply.status(403).send({ error: 'Forbidden' })
    return { ok: false }
  }

  return { ok: true, merchantId: req.auth.merchantId }
}
