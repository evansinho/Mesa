import { useQuery } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Clock, Check, Lock } from 'lucide-react'
import { api, type Wrapped } from '../lib/api'
import { getSession, isManager } from '../lib/auth'

type Dashboard = {
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
  thresholds: { warningDays: number; criticalDays: number }
}

const LIFECYCLE_LABELS: Record<string, string> = {
  SIGNED_UP: 'Signed up',
  CONNECTED: 'Connected',
  FIRST_VALUE: 'First order',
  FIRST_PAYMENT: 'First payment',
  ACTIVATED: 'Activated',
  PAYING: 'Paying',
  AT_RISK: 'At risk',
  CHURNED: 'Churned',
}

export default function OverviewPage() {
  const session = getSession()
  const { data, isLoading, error } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<Wrapped<Dashboard>>('/staff/dashboard').then((r) => r.data),
  })

  if (isLoading) {
    return (
      <div className="page">
        <div className="kpi-row">
          <div className="skeleton" style={{ height: 82 }} />
          <div className="skeleton" style={{ height: 82 }} />
          <div className="skeleton" style={{ height: 82 }} />
          <div className="skeleton" style={{ height: 82 }} />
        </div>
        <div className="skeleton" style={{ height: 220 }} />
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

  const d = data!
  const funnelMax = Math.max(...d.funnel.map((f) => f.count), 1)
  const lifecycle = d.lifecycle ?? []
  const lifecycleMax = Math.max(...lifecycle.map((l) => l.count), 1)
  const sourceMax = Math.max(...d.bySource.map((s) => s.total), 1)

  return (
    <div className="page">
      <p className="section-note">
        {isManager(session) ? 'Whole team' : 'Your prospects'} · last 7 days
      </p>

      {/* A handful of headline numbers is a stat-tile row, not a chart. */}
      <div className="kpi-row">
        <Stat label="Open prospects" value={d.kpis.open} />
        <Stat label="On Mesa" value={d.kpis.signedUp} />
        <Stat label="New this week" value={d.kpis.newThisWeek} prev={d.kpis.newLastWeek} />
        <Stat label="Touches logged" value={d.kpis.activitiesThisWeek} />
      </div>

      <div className="dash-grid">
        {/* Left column. Needs attention leads and gets the wider column,
            because it is the only section anyone acts on — everything else is
            a readout. */}
        <section>
          <h2 className="section-title">
            Needs attention
            {d.needsAttention.length > 0 && (
              <span className="section-count">{d.needsAttention.length}</span>
            )}
          </h2>
          <p className="section-note">
            Open prospects with nothing logged in {d.thresholds.warningDays}+ days.
          </p>

          {d.needsAttention.length === 0 ? (
            <div className="card all-clear">
              <Check size={16} />
              <span>Everything open has been touched recently.</span>
            </div>
          ) : (
            <div className="card list-card">
              {d.needsAttention.map((p) => (
                <Link key={p.id} to="/prospects/$id" params={{ id: p.id }}>
                  <div className="attention-row">
                    {/* Status carries an icon and a number, so colour is the
                        third channel here rather than the only one. */}
                    <span className={`status status-${p.severity}`}>
                      {p.severity === 'critical' ? <AlertTriangle size={13} /> : <Clock size={13} />}
                      {p.daysQuiet}d
                    </span>
                    <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                      <span className="name truncate">{p.businessName}</span>
                      <span className="meta truncate">
                        {p.stage.charAt(0) + p.stage.slice(1).toLowerCase()} · {p.source}
                      </span>
                    </div>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </section>

        {/* Right column: the two readouts. */}
        <div>
          {/* Funnel. Stages are ORDINAL — reordering them changes the meaning —
              so they take one hue in monotone lightness steps rather than a
              categorical palette. Every bar is directly labelled, which is what
              earns the relief for the lightest step sitting under 3:1. */}
          <section>
            <h2 className="section-title">Pipeline</h2>
            <p className="section-note">
              Sales owns the first three. Mesa owns the last.
            </p>
            <div className="card">
              {d.funnel.map((f, i) => (
                <div className="funnel-row" key={f.key}>
                  <span className="funnel-label">{f.label}</span>
                  <div className="funnel-track">
                    <div
                      className="funnel-bar"
                      data-step={i}
                      style={{
                        width: `${Math.max((f.count / funnelMax) * 100, f.count > 0 ? 6 : 0)}%`,
                      }}
                    />
                  </div>
                  <span className="funnel-value">{f.count}</span>
                </div>
              ))}
            </div>
          </section>

          {/* The derived half of the funnel. Everything here comes out of the
              product tables via the lifecycle sweep, so there is nothing for a
              rep to hand-edit and nothing to drift out of sync with reality.
              Managers and admins only — it spans every merchant. */}
          {lifecycle.length > 0 && (
            <section>
              <h2 className="section-title">After signup</h2>
              <div className="derived-note">
                <Lock size={13} />
                Worked out from what merchants actually do. Not editable.
              </div>
              <div className="card">
                {lifecycle.map((l, i) => {
                  const label = LIFECYCLE_LABELS[l.state] ?? l.state
                  const exit = l.state === 'AT_RISK' ? 'at_risk'
                    : l.state === 'CHURNED' ? 'churned' : undefined
                  return (
                    <div className="funnel-row" key={l.state}>
                      <span className="funnel-label">{label}</span>
                      <div className="funnel-track">
                        <div
                          className="funnel-bar"
                          // The two exits leave the ordinal ramp: reusing the
                          // darkest step for CHURNED would read as "furthest
                          // along", which is the opposite of what it means.
                          data-step={exit ? undefined : Math.min(i, 3)}
                          data-exit={exit}
                          style={{
                            width: `${Math.max((l.count / lifecycleMax) * 100, l.count > 0 ? 6 : 0)}%`,
                          }}
                        />
                      </div>
                      <span className="funnel-value">{l.count}</span>
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {/* Source performance. A table, because every row carries meaning and
              there are more rows than a chart should colour. The inline bar
              encodes magnitude only, so every row wears the same single hue —
              colouring nominal rows by value would spend the identity channel
              re-encoding what bar length already shows. */}
          <section>
            <h2 className="section-title">Where they came from</h2>
            <p className="section-note">
              Measured in signups, not leads. Fractions, because a percentage of five is noise.
            </p>
            <div className="card">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th className="num">Prospects</th>
                    <th className="num">Signed up</th>
                  </tr>
                </thead>
                <tbody>
                  {d.bySource.length === 0 ? (
                    <tr>
                      <td colSpan={3} className="meta">Nothing yet.</td>
                    </tr>
                  ) : (
                    d.bySource.map((s) => (
                      <tr key={s.source}>
                        <td>
                          <div className="src-cell">
                            <span>{s.source}</span>
                            <div className="src-track">
                              <div
                                className="src-bar"
                                style={{ width: `${(s.total / sourceMax) * 100}%` }}
                              />
                            </div>
                          </div>
                        </td>
                        <td className="num">{s.total}</td>
                        <td className="num">
                          {s.signedUp}
                          <span className="frac">/{s.total}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}

function Stat({ label, value, prev }: { label: string; value: number; prev?: number }) {
  const delta = prev === undefined ? null : value - prev
  const dir = delta === null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'

  return (
    <div className="kpi">
      <span className="kpi-value">{value}</span>
      <span className="kpi-label">{label}</span>
      {delta !== null && (
        // Absolute count, never a percentage: "+40% week on week" on a base of
        // five is two prospects and a public holiday. Direction rides an arrow
        // and a word, so colour is not carrying it alone.
        <span className="kpi-delta" data-dir={dir}>
          <span aria-hidden="true">{dir === 'up' ? '↑' : dir === 'down' ? '↓' : '·'}</span>
          {delta === 0 ? 'same as last week' : `${Math.abs(delta)} vs last week`}
        </span>
      )}
    </div>
  )
}
