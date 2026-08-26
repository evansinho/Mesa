import { useQuery } from '@tanstack/react-query'
import { api, type Wrapped } from '../lib/api'
import { naira, Spark } from '../components/charts'
import { initials } from '../lib/merchants'

type Row = {
  staffId: string
  name: string
  role: string
  onMesa: number
  pipeline: number
  mrr: number
}

export default function TeamPage() {
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () =>
      api
        .get<Wrapped<{ leaderboard: Row[] | null }>>('/staff/dashboard')
        .then((r) => r.data.leaderboard),
  })

  if (isLoading) return <main className="page"><div className="skeleton" style={{ height: 200 }} /></main>
  if (error) return <main className="page"><div className="notice-error">{(error as Error).message}</div></main>

  const rows = data ?? []

  if (rows.length === 0) {
    return (
      <main className="page">
        <div className="card">
          <div className="empty">Team figures are visible to managers and admins.</div>
        </div>
      </main>
    )
  }

  return (
    <main className="page">
      <div className="kpis">
        {rows.map((r, i) => (
          <div className="kpi" key={r.staffId}>
            <div className="k-top">
              <span className="k-lab">{r.role}</span>
              <span className={`avatar ${i === 0 ? 'avatar--top' : ''}`} style={{ marginLeft: 'auto' }}>
                {initials(r.name)}
              </span>
            </div>
            <span className="team-name">{r.name}</span>
            <span className="num k-val" style={{ fontSize: 30 }}>
              {r.mrr > 0 ? naira(r.mrr) : '—'}
            </span>
            <div className="k-foot">
              <span className="delta delta--flat">{r.onMesa} on Mesa</span>
              <span className="k-note">{r.pipeline} in pipeline</span>
            </div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="card-h">
          <div>
            <div className="ch-t">Leaderboard</div>
            <div className="ch-s">By MRR booked, attributed through the prospect that produced each merchant</div>
          </div>
        </div>
        <div className="lb">
          {rows.map((r, i) => (
            <div className={`lb-r ${i === 0 ? 'lb-r--top' : ''}`} key={r.staffId}>
              <span className="rk">{i + 1}</span>
              <span className="avatar">{initials(r.name)}</span>
              <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                <span className="queue-name truncate">{r.name}</span>
                <span className="lb-sub">{r.onMesa} on Mesa · {r.pipeline} in pipeline</span>
              </div>
              <Spark data={[0, Math.max(r.pipeline, 1), Math.max(r.onMesa * 2, 1)]} />
              <span className="lb-mrr">{r.mrr > 0 ? naira(r.mrr) : '—'}</span>
            </div>
          ))}
        </div>
      </div>
    </main>
  )
}
