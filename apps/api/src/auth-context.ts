import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash, timingSafeEqual } from 'crypto'
import { and, eq, gt } from 'drizzle-orm'
import { authSessions, staff, staffSessions, type Db } from '@mesa/db'
import { config } from '@mesa/config'

function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  if (bufA.length !== bufB.length) return false
  return timingSafeEqual(bufA, bufB)
}

export type StaffRole = 'admin' | 'manager' | 'member'

export type ApiAuth =
  | { kind: 'internal' }
  | { kind: 'session'; merchantId: string }
  | { kind: 'staff'; staffId: string; role: StaffRole }

declare module 'fastify' {
  interface FastifyRequest {
    auth?: ApiAuth
  }
}

function isPublicRoute(path: string, method: string): boolean {
  if (path === '/health' || path === '/ready') return true
  if (path === '/auth/request' || path === '/auth/verify') return true
  // The only credential-free staff route: the credential exchange itself.
  // Everything else under /staff/ is handled by the branch in the hook below.
  if (path === '/staff/auth/login' && method === 'POST') return true
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

async function resolveStaffSession(
  db: Db,
  authHeader: string | undefined,
): Promise<Extract<ApiAuth, { kind: 'staff' }> | null> {
  if (!authHeader?.startsWith('Bearer ')) return null

  const tokenHash = createHash('sha256').update(authHeader.slice(7)).digest('hex')
  const session = await db.query.staffSessions.findFirst({
    where: and(
      eq(staffSessions.sessionHash, tokenHash),
      gt(staffSessions.expiresAt, new Date()),
    ),
  })
  if (!session) return null

  // Role is read from the row on every request rather than baked into the
  // token, so a demotion takes effect immediately instead of at token expiry.
  // Same for deactivation — though that also deletes the session outright.
  const member = await db.query.staff.findFirst({ where: eq(staff.id, session.staffId) })
  if (!member || !member.active) return null

  return { kind: 'staff', staffId: member.id, role: member.role }
}

export function registerAuthContext(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (isPublicRoute(path, req.method)) return

    // Staff routes accept exactly one credential: a staff session.
    //
    // This branch returns before the service key and merchant session are even
    // considered, which is the point. The commercial layer reads across every
    // merchant by design, so a merchant's bearer token reaching it would be a
    // full cross-tenant breach, and the shared `x-mesa-api-key` carries no
    // staff identity for the audit log to attribute anything to. Handling it
    // here rather than in the route plugin means a new /staff route cannot opt
    // out of it by accident.
    if (path.startsWith('/staff/')) {
      const staffAuth = await resolveStaffSession(db, req.headers.authorization)
      if (!staffAuth) return reply.status(401).send({ error: 'Unauthorized' })
      req.auth = staffAuth
      return
    }

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

  // A staff session is not a merchant credential and must never be coerced
  // into one. Staff read across merchants through /staff/* with their own
  // scoping; if one reaches a merchant route, that route is misconfigured.
  if (req.auth.kind === 'staff') {
    reply.status(403).send({ error: 'Forbidden' })
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
