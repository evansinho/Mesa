import type { FastifyInstance } from 'fastify'
import { listBanks, resolveBankAccount, type PaystackBank } from '../lib/paystack'

// Nigerian bank list + account-name resolution (Paystack-backed). Used by
// onboarding so merchants pick their bank from the real list and the account
// name is verified from the account number instead of typed by hand.
let bankCache: { at: number; banks: PaystackBank[] } | null = null
const BANK_CACHE_MS = 6 * 60 * 60 * 1000

export async function bankRoutes(app: FastifyInstance) {
  app.get('/', {
    config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
  }, async (_req, reply) => {
    if (!bankCache || Date.now() - bankCache.at > BANK_CACHE_MS) {
      bankCache = { at: Date.now(), banks: await listBanks() }
    }
    return reply.send({ banks: bankCache.banks })
  })

  app.post<{ Body: { accountNumber?: string; bankCode?: string } }>('/resolve', {
    config: { rateLimit: { max: 10, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const accountNumber = (req.body.accountNumber ?? '').replace(/\D/g, '')
    const bankCode = (req.body.bankCode ?? '').trim()
    if (accountNumber.length !== 10 || !bankCode) {
      return reply.status(400).send({ error: 'accountNumber (10 digits) and bankCode are required' })
    }
    try {
      const { accountName } = await resolveBankAccount(accountNumber, bankCode)
      return reply.send({ accountName })
    } catch {
      return reply.status(422).send({ error: 'Could not verify this account. Check the account number and bank.' })
    }
  })
}
