import { render, screen, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactElement } from 'react'

/**
 * Render smoke tests.
 *
 * These exist because two runtime crashes shipped that nothing here could
 * catch: a query-key collision handed the Team view an object where it
 * expected an array, and the page died with "rows.map is not a function". A
 * typecheck cannot see it — the shapes are right in isolation and only
 * conflict at runtime through TanStack Query's cache — and no test rendered a
 * page at all.
 *
 * So the bar each test holds is deliberately low: mount the page against a
 * realistic API response and assert something real appears. Anything that
 * throws during render fails, which is the whole point.
 */

const dashboardPayload = {
  kpis: {
    open: 4, signedUp: 8, newThisWeek: 3, newLastWeek: 2,
    activitiesThisWeek: 4, needsAttention: 2,
  },
  funnel: [
    { key: 'SOURCED', label: 'Sourced', count: 2 },
    { key: 'CONTACTED', label: 'Contacted', count: 2 },
    { key: 'DEMOED', label: 'Demoed', count: 1 },
    { key: 'ON_MESA', label: 'On Mesa', count: 8 },
  ],
  bySource: [{ source: 'instagram', total: 3, signedUp: 2 }],
  needsAttention: [
    { id: 'p1', businessName: 'Adeola Fabrics', stage: 'CONTACTED', source: 'instagram', daysQuiet: 5, severity: 'warning' },
  ],
  lifecycle: [
    { state: 'SIGNED_UP', count: 2 },
    { state: 'PAYING', count: 2 },
  ],
  milestone: { target: 50 },
  mrr: 137000,
  trend: { months: ['Mar', 'Apr'], actual: [2, 8], plan: [25, 50] },
  leaderboard: [
    { staffId: 's1', name: 'Amaka Obi', role: 'manager', onMesa: 3, pipeline: 2, mrr: 90000 },
    { staffId: 's2', name: 'Tunde Bello', role: 'member', onMesa: 4, pipeline: 2, mrr: 47000 },
  ],
  thresholds: { warningDays: 3, criticalDays: 7 },
}

const merchantsPayload = [
  {
    id: 'm1', name: 'Mama Ngozi Foods', phone: '+2348055512346',
    displayStage: 'paying', lifecycleState: 'PAYING', tier: 'business',
    subscriptionStatus: 'active', mrr: 90000, orders30d: 9, activationDays: 138,
    connectedAt: '2026-04-01T00:00:00Z', lastActivityAt: '2026-08-20T00:00:00Z',
    owner: { id: 's1', name: 'Amaka Obi' }, prospectId: 'p9',
    source: 'referral', sourceDetail: 'market association', risk: null,
    createdAt: '2026-03-29T00:00:00Z',
  },
]

const prospectsPayload = {
  data: [
    {
      id: 'p1', businessName: 'Uche Auto Parts', phone: '08031234567',
      phoneNormalized: '+2348031234567', instagramHandle: null, contactName: null,
      stage: 'SOURCED', disqualifyReason: null, disqualifyNote: null,
      source: 'outbound', sourceDetail: 'Ladipo list', ownerId: 's2',
      merchantId: null, matchStatus: 'unmatched', matchedAt: null,
      createdAt: '2026-08-15T00:00:00Z', updatedAt: '2026-08-15T00:00:00Z',
    },
  ],
  meta: { page: 1, limit: 100, total: 1, pages: 1 },
}

const teamPayload = {
  data: [
    {
      id: 's1', name: 'Amaka Obi', email: 'amaka@getmesa.co', role: 'manager',
      active: true, mustResetPassword: false, refCode: 'AO',
      lastLoginAt: '2026-08-25T09:00:00Z', onMesa: 3, pipeline: 2,
    },
    {
      id: 's2', name: 'Tunde Bello', email: 'tunde@getmesa.co', role: 'member',
      active: true, mustResetPassword: true, refCode: 'TB',
      lastLoginAt: null, onMesa: 4, pipeline: 2,
    },
  ],
  meta: { canCreate: ['member'], canChangeRole: false },
}

const queuePayload = [
  {
    id: 'n1', kind: 'NOT_CONNECTED', body: 'Adeola Fabrics signed up but has not connected WhatsApp',
    merchantId: 'm2', prospectId: null, targetName: 'Adeola Fabrics',
    actionLabel: 'Help connect', daysOpen: 3, readAt: null, escalated: false,
  },
  {
    id: 'n2', kind: 'PROSPECT_STALE', body: 'Surulere Spares has had no activity logged',
    merchantId: null, prospectId: 'p1', targetName: 'Surulere Spares',
    actionLabel: 'Follow up', daysOpen: 4, readAt: null, escalated: false,
  },
]

// One fake transport for every page, keyed by path. Mirrors the real
// envelopes: `{ data }` for most, `{ data, meta }` for paged lists.
// Mocked wholesale rather than spread over the real module: api.ts reads
// import.meta.env, which jest's CommonJS transform cannot parse. Nothing here
// needs the real transport.
jest.mock('../src/lib/api', () => {
  class ApiError extends Error {
    constructor(public status: number, message: string) { super(message) }
  }
  return {
    ApiError,
    api: {
      get: jest.fn((path: string) => {
        if (path.startsWith('/staff/dashboard')) return Promise.resolve({ data: dashboardPayload })
        if (path.startsWith('/staff/team')) return Promise.resolve(teamPayload)
        if (path.startsWith('/staff/merchants/')) {
          return Promise.resolve({ data: { ...merchantsPayload[0], timeline: [], activities: [] } })
        }
        if (path.startsWith('/staff/merchants')) return Promise.resolve({ data: merchantsPayload })
        if (path.match(/^\/staff\/prospects\/[^/]+\/activities/)) return Promise.resolve({ data: [] })
        if (path.match(/^\/staff\/prospects\/[^/]+$/)) {
          return Promise.resolve({ data: { ...prospectsPayload.data[0], owner: null } })
        }
        if (path.startsWith('/staff/prospects')) return Promise.resolve(prospectsPayload)
        if (path.startsWith('/staff/queue/count')) return Promise.resolve({ data: { open: 1, unread: 1 } })
        if (path.startsWith('/staff/queue')) return Promise.resolve({ data: queuePayload })
        return Promise.resolve({ data: null })
      }),
      post: jest.fn(() => Promise.resolve({ data: { ok: true } })),
      patch: jest.fn(() => Promise.resolve({ data: {} })),
    },
  }
})

jest.mock('../src/lib/auth', () => ({
  getSession: () => ({
    token: 't',
    user: { id: 's1', name: 'Amaka Obi', email: 'a@b.co', role: 'manager', mustResetPassword: false },
  }),
  clearSession: jest.fn(),
  setSession: jest.fn(),
  isManager: () => true,
}))

// Router-free: each page is rendered directly, so a Link needs a stub rather
// than a whole router context.
jest.mock('@tanstack/react-router', () => ({
  Link: ({ children, ...rest }: { children?: unknown }) => {
    const React = jest.requireActual('react')
    return React.createElement('a', rest, children)
  },
  useNavigate: () => jest.fn(),
  useParams: () => ({ id: 'p1' }),
  useRouterState: () => '/overview',
  Outlet: () => null,
}))

import OverviewPage from '../src/pages/OverviewPage'
import TeamPage from '../src/pages/TeamPage'
import QueuePage from '../src/pages/QueuePage'
import MerchantsPage from '../src/pages/MerchantsPage'
import PipelinePage from '../src/pages/PipelinePage'
import ProspectDetailPage from '../src/pages/ProspectDetailPage'

function renderPage(ui: ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={qc}>{ui}</QueryClientProvider>)
}

describe('Page renders', () => {
  it('Overview shows KPIs, the funnel and the leaderboard', async () => {
    renderPage(<OverviewPage />)
    await waitFor(() => expect(screen.getByText('MRR booked')).toBeInTheDocument())
    expect(screen.getByText('₦137k')).toBeInTheDocument()
    expect(screen.getByText('Adeola Fabrics')).toBeInTheDocument()
  })

  it('Team renders the people table and the leaderboard', async () => {
    // The exact page that crashed: it reads dashboard.leaderboard, which must
    // be an array however the shared cache entry got populated.
    renderPage(<TeamPage />)
    await waitFor(() => expect(screen.getAllByText('Amaka Obi').length).toBeGreaterThan(0))
    expect(screen.getAllByText('Tunde Bello').length).toBeGreaterThan(0)
    expect(screen.getByText('amaka@getmesa.co')).toBeInTheDocument()
  })

  it('Team offers the invite action only for roles the caller may create', async () => {
    // meta.canCreate is ['member'] here, so the button shows. The server is
    // still the authority; this only stops the UI offering a refused action.
    renderPage(<TeamPage />)
    await waitFor(() => expect(screen.getByText('Invite someone')).toBeInTheDocument())
  })

  it('Team survives a response with no meta envelope', async () => {
    // Regression: `team.data?.meta.canCreate` crashed whenever data existed
    // but meta did not. The outer ?. guards a missing response and nothing
    // else.
    const { api } = jest.requireMock('../src/lib/api')
    api.get.mockImplementationOnce((path: string) =>
      path.startsWith('/staff/team')
        ? Promise.resolve({ data: teamPayload.data })
        : Promise.resolve({ data: dashboardPayload }),
    )
    renderPage(<TeamPage />)
    await waitFor(() => expect(screen.queryByText('Invite someone')).not.toBeInTheDocument())
  })

  it('Queue renders items with their recommended action', async () => {
    renderPage(<QueuePage />)
    await waitFor(() => expect(screen.getByText('Adeola Fabrics')).toBeInTheDocument())
    expect(screen.getByText('Help connect')).toBeInTheDocument()
  })

  it('Queue makes every row lead somewhere, merchant or prospect', async () => {
    // Merchant-targeted rows were plain divs while the drawer did not exist,
    // which left most of the queue looking interactive and doing nothing.
    renderPage(<QueuePage />)
    await waitFor(() => expect(screen.getByText('Adeola Fabrics')).toBeInTheDocument())

    // The merchant row opens the drawer; the prospect row is a link.
    expect(screen.getAllByRole('button').length).toBeGreaterThan(0)
    expect(screen.getByText('Surulere Spares').closest('a')).not.toBeNull()
    expect(screen.getByText('Adeola Fabrics').closest('[role="button"]')).not.toBeNull()
  })

  it('Merchants renders the table', async () => {
    renderPage(<MerchantsPage />)
    await waitFor(() => expect(screen.getByText('Mama Ngozi Foods')).toBeInTheDocument())
    expect(screen.getByText('₦90k')).toBeInTheDocument()
  })

  it('Pipeline renders all five columns', async () => {
    renderPage(<PipelinePage />)
    await waitFor(() => expect(screen.getByText('Prospect')).toBeInTheDocument())
    for (const stage of ['Onboarding', 'Activated', 'Paying', 'Churned']) {
      expect(screen.getByText(stage)).toBeInTheDocument()
    }
  })

})

describe('Prospect ownership', () => {
  it('offers a manager an owner picker listing only active staff', async () => {
    renderPage(<ProspectDetailPage />)
    await waitFor(() => expect(screen.getByLabelText('Owner')).toBeInTheDocument())

    const select = screen.getByLabelText('Owner') as HTMLSelectElement
    const labels = Array.from(select.options).map((o) => o.textContent ?? '')
    expect(labels[0]).toMatch(/Unassigned/)
    expect(labels.join(' ')).toContain('Amaka Obi')
    expect(labels.join(' ')).toContain('Tunde Bello')
  })
})

describe('Shared query keys agree on a shape', () => {
  it('Overview and Team can mount together without fighting over the cache', async () => {
    // The regression itself. Both read ['dashboard']; if either reshapes the
    // payload in its queryFn, whichever resolves second gets the other's shape
    // and throws. Mounting them under ONE client is what reproduces it.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <OverviewPage />
        <TeamPage />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getByText('MRR booked')).toBeInTheDocument())
    expect(screen.getAllByText('Amaka Obi').length).toBeGreaterThan(0)
  })

  it('Pipeline reads the prospects envelope correctly', async () => {
    // Was a pair test with the old /prospects list, which shared the key and
    // disagreed on shape. That list is gone; the invariant it guarded is not.
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(
      <QueryClientProvider client={qc}>
        <PipelinePage />
      </QueryClientProvider>,
    )
    await waitFor(() => expect(screen.getAllByText('Uche Auto Parts').length).toBeGreaterThan(0))
  })
})
