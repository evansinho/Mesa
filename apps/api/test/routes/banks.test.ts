const listBanksMock = jest.fn()
const resolveBankAccountMock = jest.fn()
jest.mock('../../src/lib/paystack', () => ({
  ...jest.requireActual('../../src/lib/paystack'),
  listBanks: (...args: unknown[]) => listBanksMock(...args),
  resolveBankAccount: (...args: unknown[]) => resolveBankAccountMock(...args),
}))

import Fastify from 'fastify'
import { bankRoutes } from '../../src/routes/banks'

async function build() {
  const app = Fastify()
  await app.register(bankRoutes, { prefix: '/banks' })
  return app
}

describe('bank routes', () => {
  beforeEach(() => {
    listBanksMock.mockReset()
    resolveBankAccountMock.mockReset()
  })

  it('lists banks (and caches across calls)', async () => {
    listBanksMock.mockResolvedValue([{ name: 'GTBank', code: '058' }, { name: 'Opay', code: '999992' }])
    const app = await build()

    const first = await app.inject({ method: 'GET', url: '/banks' })
    expect(first.statusCode).toBe(200)
    expect(first.json().banks).toHaveLength(2)

    await app.inject({ method: 'GET', url: '/banks' })
    expect(listBanksMock).toHaveBeenCalledTimes(1)
    await app.close()
  })

  it('resolves an account name', async () => {
    resolveBankAccountMock.mockResolvedValue({ accountName: 'EVANSON IGIRI' })
    const app = await build()

    const res = await app.inject({
      method: 'POST',
      url: '/banks/resolve',
      payload: { accountNumber: '7037464245', bankCode: '999992' },
    })
    expect(res.statusCode).toBe(200)
    expect(res.json().accountName).toBe('EVANSON IGIRI')
    await app.close()
  })

  it('rejects malformed input and maps resolve failures to 422', async () => {
    const app = await build()
    const bad = await app.inject({ method: 'POST', url: '/banks/resolve', payload: { accountNumber: '123', bankCode: '058' } })
    expect(bad.statusCode).toBe(400)

    resolveBankAccountMock.mockRejectedValue(new Error('could not resolve'))
    const failed = await app.inject({
      method: 'POST',
      url: '/banks/resolve',
      payload: { accountNumber: '0000000000', bankCode: '058' },
    })
    expect(failed.statusCode).toBe(422)
    await app.close()
  })

  // bankCache is module-level singleton state — jest.resetModules() + a
  // fresh require() per test gives each of these its own clean bankCache,
  // independent of the shared-module tests above.
  describe('resilience to upstream failures (isolated module state)', () => {
    it('returns 502 when listBanks fails and nothing has ever been cached — Sentry SyntaxError regression', async () => {
      jest.resetModules()
      jest.doMock('../../src/lib/paystack', () => ({
        listBanks: jest.fn().mockRejectedValue(new Error('Paystack /bank failed: non-JSON response (status 502)')),
        resolveBankAccount: jest.fn(),
      }))
      const Fastify = (await import('fastify')).default
      const { bankRoutes: freshBankRoutes } = await import('../../src/routes/banks')
      const app = Fastify()
      await app.register(freshBankRoutes, { prefix: '/banks' })

      const res = await app.inject({ method: 'GET', url: '/banks' })
      expect(res.statusCode).toBe(502)
      await app.close()
      jest.dontMock('../../src/lib/paystack')
    })

    it('falls back to the stale cache instead of 500ing when a later refresh fails', async () => {
      jest.resetModules()
      const freshListBanksMock = jest.fn()
      jest.doMock('../../src/lib/paystack', () => ({
        listBanks: (...args: unknown[]) => freshListBanksMock(...args),
        resolveBankAccount: jest.fn(),
      }))
      const Fastify = (await import('fastify')).default
      const { bankRoutes: freshBankRoutes } = await import('../../src/routes/banks')
      const app = Fastify()
      await app.register(freshBankRoutes, { prefix: '/banks' })

      freshListBanksMock.mockResolvedValueOnce([{ name: 'GTBank', code: '058' }])
      const first = await app.inject({ method: 'GET', url: '/banks' })
      expect(first.statusCode).toBe(200)
      expect(first.json().banks).toEqual([{ name: 'GTBank', code: '058' }])

      // Force the cache stale so the next request re-triggers a refresh,
      // then fails it — the merchant should still see the old list, not a 500.
      jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 7 * 60 * 60 * 1000)
      freshListBanksMock.mockRejectedValueOnce(new Error('non-JSON response'))
      const second = await app.inject({ method: 'GET', url: '/banks' })
      expect(second.statusCode).toBe(200)
      expect(second.json().banks).toEqual([{ name: 'GTBank', code: '058' }])

      jest.spyOn(Date, 'now').mockRestore()
      await app.close()
      jest.dontMock('../../src/lib/paystack')
    })
  })
})
