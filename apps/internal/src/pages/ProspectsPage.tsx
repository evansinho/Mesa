import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { api, type Paged, type Prospect } from '../lib/api'
import { getSession, isManager } from '../lib/auth'
import StageBadge from '../components/StageBadge'

export default function ProspectsPage() {
  const session = getSession()
  const { data, isLoading, error } = useQuery({
    queryKey: ['prospects'],
    queryFn: () => api.get<Paged<Prospect[]>>('/staff/prospects'),
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
    return (
      <div className="page">
        <div className="error">{(error as Error).message}</div>
      </div>
    )
  }

  const prospects = data?.data ?? []

  return (
    <div className="page">
      <div className="row between" style={{ marginBottom: 12 }}>
        <span className="meta">
          {data?.meta.total ?? 0} {data?.meta.total === 1 ? 'prospect' : 'prospects'}
          {!isManager(session) && ' · yours and unclaimed'}
        </span>
      </div>

      {prospects.length === 0 ? (
        <div className="empty">
          <p>No prospects yet.</p>
          <Link to="/prospects/new" className="btn" style={{ marginTop: 12 }}>
            Add the first one
          </Link>
        </div>
      ) : (
        prospects.map((p) => (
          <Link key={p.id} to="/prospects/$id" params={{ id: p.id }}>
            <div className="card tap">
              <div className="row between">
                <div className="stack">
                  <span className="name">{p.businessName}</span>
                  <span className="mono">{p.phoneNormalized}</span>
                  <span className="meta">
                    {p.source}
                    {p.sourceDetail ? ` · ${p.sourceDetail}` : ''}
                    {p.ownerId === null && ' · unclaimed'}
                  </span>
                </div>
                <StageBadge prospect={p} />
              </div>
            </div>
          </Link>
        ))
      )}
    </div>
  )
}
