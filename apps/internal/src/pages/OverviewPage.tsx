import { Link } from '@tanstack/react-router'
import {
  Target, Banknote, Zap, Send, Activity, AlertTriangle, Clock, Check, Lock, ArrowUp, ArrowDown,
} from 'lucide-react'
import { useDashboard } from '../lib/dashboard'
import { TrendChart, Spark, naira } from '../components/charts'
import { getSession, isManager } from '../lib/auth'

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

// Stage colours come from the handoff's five-stage palette. The two exits sit
// outside the progression, so they take status colours rather than a further
// step along the ramp: reusing the "furthest along" tone for churn would say
// the opposite of what it means.
const LIFECYCLE_TONE: Record<string, string> = {
  SIGNED_UP: 'var(--stage-prospect)',
  CONNECTED: 'var(--stage-onboarding)',
  FIRST_VALUE: 'var(--stage-activated)',
  FIRST_PAYMENT: 'var(--stage-activated)',
  ACTIVATED: 'var(--stage-activated)',
  PAYING: 'var(--stage-paying)',
  AT_RISK: 'var(--clay-500)',
  CHURNED: 'var(--stage-churned)',
}

const FUNNEL_TONE: Record<string, string> = {
  SOURCED: 'var(--stage-prospect)',
  CONTACTED: 'var(--stage-onboarding)',
  DEMOED: 'var(--stage-activated)',
  ON_MESA: 'var(--stage-paying)',
}

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('')
}

export default function OverviewPage() {
  const session = getSession()
  const { data, isLoading, error } = useDashboard()

  if (isLoading) {
    return (
      <main className="page">
        <div className="kpis">
          {[0, 1, 2, 3].map((i) => <div key={i} className="skeleton" style={{ height: 132 }} />)}
        </div>
        <div className="skeleton" style={{ height: 220 }} />
      </main>
    )
  }

  if (error) {
    return (
      <main className="page">
        <div className="notice-error">{(error as Error).message}</div>
      </main>
    )
  }

  const d = data!
  const funnelTop = Math.max(...d.funnel.map((f) => f.count), 1)
  const lifecycle = d.lifecycle ?? []
  const lifecycleTop = Math.max(...lifecycle.map((l) => l.count), 1)
  const sourceTop = Math.max(...d.bySource.map((s) => s.total), 1)

  const signedDelta = d.kpis.newThisWeek - d.kpis.newLastWeek

  // Company progress, not the caller's. kpis.signedUp IS scoped to the caller,
  // so using it here told a rep the company was at 8% when it was at 16% — a
  // different claim, not a smaller view of the same one.
  const pctOfMilestone = Math.min(
    100,
    Math.round((d.milestone.actual / Math.max(d.milestone.target, 1)) * 100),
  )
  // True when the caller only sees part of the book, which is what makes the
  // distinction between the two numbers worth drawing.
  const scoped = d.milestone.actual !== d.kpis.signedUp

  return (
    <main className="page">
      {/* KPI row. Exactly one hero card, which is where the forest field and
          the accent numeral are spent. */}
      <div className="kpis">
        <Kpi
          hero
          label={d.milestone.label}
          display={`${d.milestone.actual}`}
          value={d.milestone.actual}
          unit={`/ ${d.milestone.target}`}
          icon={<Target size={15} />}
          progress={pctOfMilestone}
          note={
            scoped
              ? `${pctOfMilestone}% company-wide · ${d.kpis.signedUp} of them yours`
              : `${pctOfMilestone}% there`
          }
        />
        {d.mrr !== null ? (
          <Kpi
            label="MRR booked"
            display={naira(d.mrr)}
            value={d.mrr}
            icon={<Banknote size={15} />}
            note="merchants on an active plan"
          />
        ) : (
          <Kpi
            label="Open prospects"
            value={d.kpis.open}
            icon={<Zap size={15} />}
            note="yours and unclaimed"
          />
        )}
        <Kpi
          label="New this week"
          value={d.kpis.newThisWeek}
          icon={<Send size={15} />}
          delta={signedDelta}
          note="vs last week"
        />
        <Kpi
          label="Touches logged"
          value={d.kpis.activitiesThisWeek}
          icon={<Activity size={15} />}
          note="calls, demos and notes"
        />
      </div>

      {/* Secondary strip. Four figures that give context but never need acting
          on, so they get one card and no chrome of their own. */}
      <div className="card strip">
        <div>
          <span className="mono">Needs attention</span>
          <span className={`num s-val ${d.kpis.needsAttention > 0 ? 's-val--clay' : ''}`}>
            {d.kpis.needsAttention}
          </span>
          <span className="k-note">accounts flagged for follow-up</span>
        </div>
        <div>
          <span className="mono">Sourced</span>
          <span className="num s-val">{d.funnel.find((f) => f.key === 'SOURCED')?.count ?? 0}</span>
          <span className="k-note">not yet contacted</span>
        </div>
        <div>
          <span className="mono">Demoed</span>
          <span className="num s-val">{d.funnel.find((f) => f.key === 'DEMOED')?.count ?? 0}</span>
          <span className="k-note">awaiting a decision</span>
        </div>
        <div>
          <span className="mono">Sources live</span>
          <span className="num s-val">{d.bySource.length}</span>
          <span className="k-note">channels producing prospects</span>
        </div>
      </div>

      {/* Charts row. Actual against a straight-line ramp to the milestone —
          the legend says "plan", and it is a target spread evenly rather than
          a forecast, so nobody reads the dashed line as a projection. */}
      {d.trend && (
        <div className="two-col">
          <div className="card">
            <div className="card-h">
              <div>
                <div className="ch-t">Merchants on Mesa</div>
                <div className="ch-s">Cumulative, last six months</div>
              </div>
              <div className="ch-r">
                <span className="legend"><i className="sw sw--actual" />actual</span>
                <span className="legend"><i className="sw sw--plan" />plan</span>
              </div>
            </div>
            <div style={{ padding: '10px 22px 18px' }}>
              <TrendChart months={d.trend.months} actual={d.trend.actual} plan={d.trend.plan} />
            </div>
          </div>

          {d.leaderboard && d.leaderboard.length > 0 && (
            <div className="card">
              <div className="card-h">
                <div>
                  <div className="ch-t">Team</div>
                  <div className="ch-s">By MRR booked</div>
                </div>
              </div>
              <div className="lb">
                {d.leaderboard.map((r, i) => (
                  <div className={`lb-r ${i === 0 ? 'lb-r--top' : ''}`} key={r.staffId}>
                    <span className="rk">{i + 1}</span>
                    <span className="avatar">{initials(r.name)}</span>
                    <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                      <span className="queue-name truncate">{r.name}</span>
                      <span className="lb-sub">
                        {r.onMesa} on Mesa · {r.pipeline} in pipeline
                      </span>
                    </div>
                    <Spark data={[0, Math.max(r.pipeline, 1), Math.max(r.onMesa * 2, 1)]} />
                    <span className="lb-mrr">{r.mrr > 0 ? naira(r.mrr) : '—'}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}

      <div className="two-col">
        {/* Needs attention leads and takes the wider column. It is the only
            section anyone acts on; everything else is a readout. */}
        <div className="card">
          <div className="card-h">
            <div>
              <div className="ch-t">Needs attention</div>
              <div className="ch-s">
                Open prospects with nothing logged in {d.thresholds.warningDays}+ days
              </div>
            </div>
            {d.needsAttention.length > 0 && (
              <div className="ch-r">
                <span className="mono">{d.needsAttention.length} flagged</span>
              </div>
            )}
          </div>

          {d.needsAttention.length === 0 ? (
            <div className="all-clear">
              <Check size={16} />
              <span>Everything open has been touched recently.</span>
            </div>
          ) : (
            <div style={{ padding: '6px 22px 14px' }}>
              {d.needsAttention.map((p) => (
                <Link key={p.id} to="/prospects/$id" params={{ id: p.id }} className="card-link">
                  <div className="list-row">
                    <span className="avatar">{initials(p.businessName)}</span>
                    <div className="stack" style={{ flex: 1, minWidth: 0 }}>
                      <span className="queue-name truncate">{p.businessName}</span>
                      <span className="meta truncate">
                        {p.stage.charAt(0) + p.stage.slice(1).toLowerCase()} · {p.source}
                      </span>
                    </div>
                    {/* Icon plus a figure, so colour is the third channel
                        carrying severity rather than the only one. */}
                    <span
                      className="mono"
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 5,
                        color: p.severity === 'critical' ? 'var(--danger)' : 'var(--clay-500)',
                        letterSpacing: '0.04em',
                      }}
                    >
                      {p.severity === 'critical' ? <AlertTriangle size={13} /> : <Clock size={13} />}
                      {p.daysQuiet}d
                    </span>
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-4)' }}>
          {/* Before signup. Human-owned stages, so a rep can move these. */}
          <div className="card">
            <div className="card-h">
              <div>
                <div className="ch-t">Pipeline</div>
                <div className="ch-s">Where accounts sit before signup</div>
              </div>
            </div>
            <div className="funnel">
              {d.funnel.map((f, i) => {
                const prev = i > 0 ? d.funnel[i - 1].count : null
                return (
                  <div className="funnel-row" key={f.key}>
                    <span className="funnel-label">{f.label}</span>
                    <div className="funnel-track">
                      <div
                        className="funnel-fill"
                        style={{
                          width: `${Math.max((f.count / funnelTop) * 100, 11)}%`,
                          background: FUNNEL_TONE[f.key] ?? 'var(--stage-prospect)',
                        }}
                      >
                        {f.count}
                      </div>
                    </div>
                    <span className="funnel-conv">
                      {prev === null || prev === 0 ? '—' : `${Math.round((f.count / prev) * 100)}%`}
                    </span>
                  </div>
                )
              })}
            </div>
          </div>

          {/* After signup. Derived from the product tables by the sweep, so
              there is nothing here for a rep to hand-edit. */}
          {lifecycle.length > 0 && (
            <div className="card">
              <div className="card-h">
                <div>
                  <div className="ch-t">After signup</div>
                  <div className="ch-s">Worked out from what merchants actually do</div>
                </div>
              </div>
              <div className="funnel">
                <div className="notice-info">
                  <Lock size={13} />
                  Derived from product data. Not editable.
                </div>
                {lifecycle.map((l) => (
                  <div className="funnel-row" key={l.state}>
                    <span className="funnel-label">{LIFECYCLE_LABELS[l.state] ?? l.state}</span>
                    <div className="funnel-track">
                      <div
                        className="funnel-fill"
                        style={{
                          width: `${Math.max((l.count / lifecycleTop) * 100, l.count > 0 ? 11 : 0)}%`,
                          background: LIFECYCLE_TONE[l.state] ?? 'var(--stage-prospect)',
                        }}
                      >
                        {l.count > 0 ? l.count : ''}
                      </div>
                    </div>
                    <span className="funnel-conv" />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* A table, because every row carries meaning and there are more rows
              than a chart should colour. */}
          <div className="card">
            <div className="card-h">
              <div>
                <div className="ch-t">Where they came from</div>
                <div className="ch-s">Counted in signups, not leads</div>
              </div>
            </div>
            <div className="tbl-wrap">
              <table className="tbl">
                <thead>
                  <tr>
                    <th>Source</th>
                    <th className="n">Prospects</th>
                    <th className="n">On Mesa</th>
                  </tr>
                </thead>
                <tbody>
                  {d.bySource.length === 0 ? (
                    <tr><td colSpan={3} className="meta">Nothing yet.</td></tr>
                  ) : (
                    d.bySource.map((s) => (
                      <tr key={s.source}>
                        <td>
                          {s.source}
                          {/* Magnitude only, so every row wears the same hue.
                              Colouring by value would re-encode what bar
                              length already shows. */}
                          <div className="bar-mini">
                            <i style={{ width: `${(s.total / sourceTop) * 100}%` }} />
                          </div>
                        </td>
                        <td className="n">{s.total}</td>
                        <td className="n-strong">
                          {s.signedUp}
                          <span className="frac">/{s.total}</span>
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      </div>
    </main>
  )
}

function Kpi({
  label, value, display, unit, icon, note, delta, hero, progress,
}: {
  label: string
  value: number
  /** Pre-formatted figure (₦ compact). Falls back to the raw value. */
  display?: string
  /** Suffix rendered at 0.46em, per the design system's numeral spec. */
  unit?: string
  icon: React.ReactNode
  note: string
  delta?: number
  hero?: boolean
  progress?: number
}) {
  const dir = delta === undefined ? null : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat'

  return (
    <div className={`kpi ${hero ? 'kpi--hero' : ''}`}>
      <div className="k-top">
        <span className="k-lab">{label}</span>
        <span className="k-ic">{icon}</span>
      </div>

      <span className="num k-val">
        {display ?? value}
        {unit && <small> {unit}</small>}
      </span>

      {progress !== undefined && (
        <div className="k-bar"><i style={{ width: `${progress}%` }} /></div>
      )}

      <div className="k-foot">
        {dir && (
          // An absolute count, never a percentage. "+40% week on week" on a
          // base of five is two prospects and a public holiday. Direction rides
          // an arrow as well as the tone.
          <span className={`delta delta--${dir}`}>
            {dir === 'up' ? <ArrowUp size={11} /> : dir === 'down' ? <ArrowDown size={11} /> : null}
            {delta === 0 ? 'no change' : Math.abs(delta!)}
          </span>
        )}
        <span className="k-note">{note}</span>
      </div>
    </div>
  )
}
