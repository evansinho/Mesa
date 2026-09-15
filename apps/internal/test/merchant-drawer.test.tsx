import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'

/**
 * The "mark as test account" toggle is a metrics-integrity lever (see
 * apps/api/src/staff/routes/merchants.ts's merchant:mark-test permission) —
 * it must only be visible to an admin, since the endpoint itself is
 * admin-only. These tests vary the mocked session role to prove that.
 */

let mockRole: 'admin' | 'manager' | 'member' = 'admin'

const merchantDetail = {
  id: 'm1', name: 'Luxury beauty wears', phone: '+2348035677120',
  displayStage: 'paying', lifecycleState: 'PAYING', tier: 'starter',
  subscriptionStatus: 'active', isTestAccount: false, mrr: 0,
  orders30d: 0, activationDays: null, connectedAt: null, lastActivityAt: null,
  owner: null, prospectId: null, source: 'organic', sourceDetail: null,
  risk: null, createdAt: '2026-08-13T00:00:00Z',
  timeline: [], activities: [],
}

jest.mock('../src/lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  }
  return {
    ApiError,
    api: {
      get: jest.fn((path: string) => {
        if (path.startsWith('/staff/team')) return Promise.resolve({ data: [] })
        if (path.startsWith('/staff/merchants/')) return Promise.resolve({ data: merchantDetail })
        return Promise.resolve({ data: null })
      }),
      post: jest.fn(() => Promise.resolve({ data: {} })),
      patch: jest.fn(() => Promise.resolve({ data: {} })),
    },
  }
})

jest.mock('../src/lib/auth', () => ({
  getSession: () => ({
    token: 't',
    user: { id: 's1', name: 'Test Staff', email: 'a@b.co', role: mockRole, mustResetPassword: false },
  }),
  isManager: () => mockRole === 'admin' || mockRole === 'manager',
  isAdmin: () => mockRole === 'admin',
}))

import { api } from '../src/lib/api'
import MerchantDrawer from '../src/components/MerchantDrawer'

const patchMock = jest.mocked(api.patch)

function renderDrawer(): ReactElement {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const el = <QueryClientProvider client={qc}><MerchantDrawer merchantId="m1" onClose={() => {}} /></QueryClientProvider>
  render(el)
  return el
}

describe('MerchantDrawer — mark as test account (admin-only)', () => {
  afterEach(() => {
    patchMock.mockClear()
  })

  it('shows the toggle for an admin and PATCHes the endpoint on click', async () => {
    mockRole = 'admin'
    renderDrawer()
    await waitFor(() => expect(screen.getByText('Luxury beauty wears')).toBeInTheDocument())

    const btn = await screen.findByText('Mark as test account')
    fireEvent.click(btn)

    await waitFor(() =>
      expect(patchMock).toHaveBeenCalledWith('/staff/merchants/m1/test-account', { isTestAccount: true })
    )
  })

  it('hides the toggle for a manager', async () => {
    mockRole = 'manager'
    renderDrawer()
    await waitFor(() => expect(screen.getByText('Luxury beauty wears')).toBeInTheDocument())
    expect(screen.queryByText('Mark as test account')).not.toBeInTheDocument()
  })

  it('hides the toggle for a member', async () => {
    mockRole = 'member'
    renderDrawer()
    await waitFor(() => expect(screen.getByText('Luxury beauty wears')).toBeInTheDocument())
    expect(screen.queryByText('Mark as test account')).not.toBeInTheDocument()
  })
})
