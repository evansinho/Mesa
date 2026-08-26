import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify'
import type { Db } from '@mesa/db'
import { isStaff } from './permissions'
import { staffAuthRoutes, staffAuthedAuthRoutes } from './routes/auth'
import { prospectRoutes } from './routes/prospects'
import { dashboardRoutes } from './routes/dashboard'

/**
 * Deny-by-default guard for the whole /staff prefix.
 *
 * Registered as a plugin-wide preHandler rather than per-route on purpose:
 * every route added inside the private plugin below is protected without its
 * author having to remember. Opt-in enforcement fails the first time someone
 * is in a hurry, and the failure mode here is a merchant reading every other
 * merchant's revenue.
 *
 * The onRequest hook in auth-context.ts has already rejected anything that
 * isn't a valid staff session on this prefix. This is the second lock.
 */
async function requireStaff(req: FastifyRequest, reply: FastifyReply) {
  if (!isStaff(req.auth)) {
    return reply.status(401).send({ error: 'Unauthorized' })
  }
}

export async function registerStaffRoutes(app: FastifyInstance, db: Db): Promise<void> {
  // Public: the credential exchange itself, and nothing else. Kept in its own
  // encapsulated plugin so "which staff routes are unauthenticated" has
  // exactly one answer, visible here.
  await app.register(async (pub) => staffAuthRoutes(pub, db), { prefix: '/staff/auth' })

  // Everything else.
  await app.register(async (priv) => {
    priv.addHook('preHandler', requireStaff)
    await priv.register(async (a) => staffAuthedAuthRoutes(a, db), { prefix: '/auth' })
    await priv.register(async (p) => prospectRoutes(p, db), { prefix: '/prospects' })
    await priv.register(async (d) => dashboardRoutes(d, db), { prefix: '/dashboard' })
  }, { prefix: '/staff' })
}
