import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import {
  AlertTriangle, PlugZap, ShoppingBag, Clock, CreditCard,
  TrendingDown, UserPlus, ArrowUpCircle, Check,
} from 'lucide-react'
import { api, type Wrapped } from '../lib/api'
import MerchantDrawer from '../components/MerchantDrawer'

type QueueItem = {
  id: string
  kind: string
  body: string
  merchantId: string | null
  prospectId: string | null
  targetName: string | null
  actionLabel: string
  daysOpen: number
  readAt: string | null
  escalated: boolean
}

// Severity is a property of the trigger, not of how long it has been sitting.
// A lapsing trial is urgent on day one; a quiet prospect is not urgent on day
// ten. Ranking by age instead would bury the expensive items.
const SEVERITY: Record<string, 'critical' | 'warning'> = {
  ESCALATION: 'critical',
  TRIAL_ENDING_NO_VALUE: 'critical',
  NOT_CONNECTED: 'critical',
  PAST_DUE: 'critical',
  AT_RISK: 'warning',
  NO_FIRST_ORDER: 'warning',
  SIGNUP_UNOWNED: 'warning',
  PROSPECT_STALE: 'warning',
}

const ICONS: Record<string, typeof Clock> = {
  ESCALATION: ArrowUpCircle,
  TRIAL_ENDING_NO_VALUE: Clock,
  NOT_CONNECTED: PlugZap,
  PAST_DUE: CreditCard,
  AT_RISK: TrendingDown,
  NO_FIRST_ORDER: ShoppingBag,
  SIGNUP_UNOWNED: UserPlus,
  PROSPECT_STALE: AlertTriangle,
}

export default function QueuePage() {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['queue'],
    queryFn: () => api.get<Wrapped<QueueItem[]>>('/staff/queue').then((r) => r.data),
  })

  const markRead = useMutation({
    mutationFn: (ids: string[]) => api.post('/staff/queue/read', { ids }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['queue', 'count'] }),
  })

  // Seeing the queue is what "read" means. Resolving is a different thing
  // entirely and only the sweep does it — a rep cannot dismiss a merchant who
  // still hasn't connected.
  const unreadIds = data?.filter((i) => !i.readAt).map((i) => i.id) ?? []
  useEffect(() => {
    if (unreadIds.length > 0) markRead.mutate(unreadIds)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unreadIds.join(',')])

  if (isLoading) {
    return (
      <main className="page">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </main>
    )
  }
  if (error) {
    return <main className="page"><div className="notice-error">{(error as Error).message}</div></main>
  }

  const items = data ?? []

  return (
    <main className="page">
      <h2 className="queue-heading">
        {items.length === 0
          ? 'Nothing needs you right now'
          : `${items.length} ${items.length === 1 ? 'merchant needs' : 'merchants need'} you`}
      </h2>
      <p className="section-note">
        Ranked by what it costs to ignore. Items close themselves once the
        underlying problem goes away.
      </p>

      {items.length === 0 ? (
        <div className="card all-clear">
          <Check size={16} />
          <span>Every open account has been dealt with.</span>
        </div>
      ) : (
        items.map((item) => {
          const severity = SEVERITY[item.kind] ?? 'warning'
          const Icon = ICONS[item.kind] ?? AlertTriangle

          const row = (
            <div className="queue-card">
              <div className={`queue-icon queue-icon--${severity}`}>
                <Icon size={16} />
              </div>
              <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                <span className="queue-name truncate">{item.targetName ?? 'Unknown'}</span>
                <span className="meta">{item.body}</span>
                <div className="queue-foot">
                  {/* The recommended action is the point: a list tells you
                      what happened, a queue tells you what to do. */}
                  <span className="action-chip">{item.actionLabel}</span>
                  <span className="q-days">{item.daysOpen === 0 ? 'today' : `${item.daysOpen}d open`}</span>
                  {item.escalated && <span className="badge badge--danger">escalated</span>}
                </div>
              </div>
            </div>
          )

          // Every row leads somewhere: a prospect to its record, a merchant to
          // the drawer. Earlier the merchant rows were plain divs because the
          // drawer did not exist yet, which left most of the queue looking
          // interactive and doing nothing.
          if (item.prospectId) {
            return (
              <Link key={item.id} to="/prospects/$id" params={{ id: item.prospectId }}>
                {row}
              </Link>
            )
          }

          return (
            <div
              key={item.id}
              role="button"
              tabIndex={0}
              className="queue-open"
              onClick={() => item.merchantId && setOpenId(item.merchantId)}
              onKeyDown={(e) => {
                if ((e.key === 'Enter' || e.key === ' ') && item.merchantId) {
                  e.preventDefault()
                  setOpenId(item.merchantId)
                }
              }}
            >
              {row}
            </div>
          )
        })
      )}

      <MerchantDrawer merchantId={openId} onClose={() => setOpenId(null)} />
    </main>
  )
}
