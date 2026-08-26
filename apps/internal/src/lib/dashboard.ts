import { useQuery } from '@tanstack/react-query'
import { api, type Wrapped } from './api'

/**
 * The dashboard payload, fetched through ONE hook.
 *
 * Three separate components read this endpoint. When they each declared their
 * own useQuery under the key ['dashboard'] but returned different shapes from
 * queryFn — the whole payload in two of them, just `.leaderboard` in the third
 * — they shared a single cache entry and whichever resolved first won. The
 * Team view then got handed an object where it expected an array and crashed
 * with "rows.map is not a function".
 *
 * One key, one shape, one place. Consumers narrow with `select` or by reading
 * a field, never by changing what queryFn returns.
 */
export type DashboardData = {
  kpis: {
    open: number
    signedUp: number
    newThisWeek: number
    newLastWeek: number
    activitiesThisWeek: number
    needsAttention: number
  }
  funnel: { key: string; label: string; count: number }[]
  bySource: { source: string; total: number; signedUp: number }[]
  needsAttention: {
    id: string
    businessName: string
    stage: string
    source: string
    daysQuiet: number
    severity: 'warning' | 'critical'
  }[]
  lifecycle: { state: string; count: number }[] | null
  /** Company-wide, never scoped to the caller. See the note in OverviewPage. */
  milestone: { label: string; target: number; actual: number }
  mrr: number | null
  trend: { months: string[]; actual: number[]; plan: number[] } | null
  leaderboard:
    | { staffId: string; name: string; role: string; onMesa: number; pipeline: number; mrr: number }[]
    | null
  thresholds: { warningDays: number; criticalDays: number }
}

export const DASHBOARD_KEY = ['dashboard'] as const

export function useDashboard() {
  return useQuery({
    queryKey: DASHBOARD_KEY,
    queryFn: () => api.get<Wrapped<DashboardData>>('/staff/dashboard').then((r) => r.data),
  })
}
