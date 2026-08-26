import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, type Paged, type Prospect, type ProspectStage } from '../lib/api'
import { getSession, isManager } from '../lib/auth'
import StageBadge from '../components/StageBadge'

// Display order is the funnel order, not alphabetical. ON_MESA is not a stage
// — it is the point the sales team hands over — so it gets its own group at
// the end rather than being mixed into the stage list.
const GROUPS: { key: ProspectStage | 'ON_MESA'; label: string }[] = [
  { key: 'DEMOED', label: 'Demoed' },
  { key: 'CONTACTED', label: 'Contacted' },
  { key: 'SOURCED', label: 'Sourced' },
  { key: 'ON_MESA', label: 'On Mesa' },
  { key: 'DORMANT', label: 'Dormant' },
  { key: 'DISQUALIFIED', label: 'Disqualified' },
]

function groupOf(p: Prospect): ProspectStage | 'ON_MESA' {
  return p.merchantId ? 'ON_MESA' : p.stage
}

function daysAgo(iso: string): string {
  const days = Math.floor((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${days}d ago`
}

export default function ProspectsPage() {
  const session = getSession()
  const { data, isLoading, error } = useQuery({
    queryKey: ['prospects'],
    queryFn: () => api.get<Paged<Prospect[]>>('/staff/prospects?limit=100'),
  })

  if (isLoading) {
    return (
      <div className="page">
        <div className="skeleton" />
        <div className="skeleton" />
        <div className="skeleton" />
      </div>
    )
  }
  if (error) {
    return <div className="page"><div className="error">{(error as Error).message}</div></div>
  }

  const prospects = data?.data ?? []

  if (prospects.length === 0) {
    return (
      <div className="page">
        <div className="empty">
          <p>No prospects yet.</p>
          <Link to="/prospects/new" className="btn" style={{ marginTop: 12 }}>
            Add the first one
          </Link>
        </div>
      </div>
    )
  }

  return (
    <div className="page">
      <p className="section-note">
        {data?.meta.total} total · {isManager(session) ? 'whole team' : 'yours and unclaimed'}
      </p>

      {GROUPS.map(({ key, label }) => {
        const rows = prospects.filter((p) => groupOf(p) === key)
        if (rows.length === 0) return null

        return (
          <section key={key}>
            <h2 className="section-title">
              {label}
              <span className="group-count">{rows.length}</span>
            </h2>

            {rows.map((p) => (
              <Link key={p.id} to="/prospects/$id" params={{ id: p.id }}>
                <div className="card tap">
                  <div className="row between">
                    <div className="stack" style={{ minWidth: 0, flex: 1 }}>
                      <span className="name truncate">{p.businessName}</span>
                      <span className="meta truncate">
                        {p.source}
                        {p.sourceDetail ? ` · ${p.sourceDetail}` : ''}
                      </span>
                      <span className="meta">
                        {p.ownerId === null ? 'unclaimed' : `touched ${daysAgo(p.updatedAt)}`}
                      </span>
                    </div>
                    <StageBadge prospect={p} />
                  </div>
                </div>
              </Link>
            ))}
          </section>
        )
      })}
    </div>
  )
}
