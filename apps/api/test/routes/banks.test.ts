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
})
