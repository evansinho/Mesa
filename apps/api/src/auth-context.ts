import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import { createHash } from 'crypto'
import { and, eq, gt } from 'drizzle-orm'
import { authSessions, type Db } from '@mesa/db'
import { config } from '@mesa/config'

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
  if (path === '/merchants' && method === 'POST') return true
  return false
}

export function registerAuthContext(app: FastifyInstance, db: Db): void {
  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]
    if (isPublicRoute(path, req.method)) return

    const apiKey = req.headers['x-mesa-api-key']
    if (apiKey === config.INTERNAL_API_KEY) {
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
