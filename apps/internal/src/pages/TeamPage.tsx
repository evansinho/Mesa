import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { UserPlus, Copy, Check, KeyRound, X, Target } from 'lucide-react'
import { api, ApiError, type Wrapped } from '../lib/api'
import { naira, Spark } from '../components/charts'
import { initials } from '../lib/merchants'
import { useDashboard } from '../lib/dashboard'
import { getSession } from '../lib/auth'

type Member = {
  id: string
  name: string
  email: string
  role: 'admin' | 'manager' | 'member'
  active: boolean
  mustResetPassword: boolean
  refCode: string | null
  lastLoginAt: string | null
  onMesa: number
  pipeline: number
}

type TeamResponse = {
  data: Member[]
  meta: { canCreate: string[]; canChangeRole: boolean }
}

export default function TeamPage() {
  const qc = useQueryClient()
  const dashboard = useDashboard()
  const [inviting, setInviting] = useState(false)
  const [issued, setIssued] = useState<{ name: string; email: string; password: string } | null>(null)

  const team = useQuery({
    queryKey: ['team'],
    queryFn: () => api.get<TeamResponse>('/staff/team'),
  })

  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) =>
      api.patch(`/staff/team/${id}`, { active }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['team'] }),
  })

  const resetPassword = useMutation({
    mutationFn: (m: Member) =>
      api
        .post<Wrapped<{ tempPassword: string }>>(`/staff/team/${m.id}/reset-password`)
        .then((r) => ({ member: m, password: r.data.tempPassword })),
    onSuccess: ({ member, password }) =>
      setIssued({ name: member.name, email: member.email, password }),
  })

  if (team.isLoading) {
    return <main className="page"><div className="skeleton" style={{ height: 220 }} /></main>
  }

  if (team.error) {
    // A member hitting this route gets a 403 from requirePermission, which is
    // the correct answer rather than an error to apologise for.
    return (
      <main className="page">
        <div className="card">
          <div className="empty">Team figures are visible to managers and admins.</div>
        </div>
      </main>
    )
  }

  const members = team.data?.data ?? []
  const canCreate = team.data?.meta?.canCreate ?? []
  const canChangeRole = team.data?.meta?.canChangeRole ?? false
  const leaderboard = dashboard.data?.leaderboard ?? []

  return (
    <main className="page">
      {issued && (
        <TempPasswordNotice issued={issued} onDismiss={() => setIssued(null)} />
      )}

      {canCreate.length > 0 && (
        <div className="toolbar">
          <span className="mono">{members.filter((m) => m.active).length} active</span>
          <button
            className="btn btn--primary btn--sm"
            style={{ marginLeft: 'auto' }}
            onClick={() => setInviting((v) => !v)}
          >
            <UserPlus size={15} />
            Invite someone
          </button>
        </div>
      )}

      {inviting && (
        <InviteForm
          allowedRoles={canCreate}
          onDone={(result) => {
            setInviting(false)
            setIssued(result)
            qc.invalidateQueries({ queryKey: ['team'] })
          }}
          onCancel={() => setInviting(false)}
        />
      )}

      {getSession()?.user.role === 'admin' && <TargetCard />}

      <div className="card tbl-wrap">
        <div className="card-h">
          <div>
            <div className="ch-t">People</div>
            <div className="ch-s">Who can sign in, and what they own</div>
          </div>
        </div>
        <table className="tbl">
          <thead>
            <tr>
              <th>Name</th>
              <th>Role</th>
              <th className="n">On Mesa</th>
              <th className="n">Pipeline</th>
              <th className="n">Last sign-in</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {members.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'is-inactive'}>
                <td>
                  <div className="row" style={{ gap: 11 }}>
                    <span className="avatar">{initials(m.name)}</span>
                    <div className="stack" style={{ minWidth: 0 }}>
                      <span className="queue-name truncate">{m.name}</span>
                      <span className="lb-sub truncate">{m.email}</span>
                    </div>
                  </div>
                </td>
                <td>
                  <span className={`badge badge--${m.role === 'admin' ? 'success' : m.role === 'manager' ? 'info' : 'neutral'}`}>
                    {m.role}
                  </span>
                  {!m.active && <span className="badge badge--danger" style={{ marginLeft: 6 }}>disabled</span>}
                  {m.mustResetPassword && m.active && (
                    <span className="badge badge--warning" style={{ marginLeft: 6 }}>not signed in</span>
                  )}
                </td>
                <td className="n">{m.onMesa}</td>
                <td className="n">{m.pipeline}</td>
                <td className="n meta">
                  {m.lastLoginAt
                    ? new Date(m.lastLoginAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })
                    : 'never'}
                </td>
                <td className="n">
                  {(canChangeRole || m.role === 'member') && (
                    <div className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                      <button
                        className="btn btn--secondary btn--sm"
                        onClick={() => resetPassword.mutate(m)}
                        disabled={resetPassword.isPending}
                        title="Issue a new temporary password"
                      >
                        <KeyRound size={13} />
                      </button>
                      <button
                        className="btn btn--secondary btn--sm"
                        onClick={() => setActive.mutate({ id: m.id, active: !m.active })}
                        disabled={setActive.isPending}
                      >
                        {m.active ? 'Disable' : 'Enable'}
                      </button>
                    </div>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {leaderboard.length > 0 && (
        <div className="card">
          <div className="card-h">
            <div>
              <div className="ch-t">Leaderboard</div>
              <div className="ch-s">
                By MRR booked, attributed through the prospect that produced each merchant
              </div>
            </div>
          </div>
          <div className="lb">
            {leaderboard.map((r, i) => (
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
      )}
    </main>
  )
}

/**
 * The company milestone.
 *
 * Admin only, because the spec puts targets with the CCO. Someone who owns
 * hitting a number and can also move it does not have a target, they have a
 * suggestion — so the Head of Sales sees the number everywhere and sets it
 * nowhere.
 */
function TargetCard() {
  const qc = useQueryClient()
  const dashboard = useDashboard()
  const [editing, setEditing] = useState(false)
  const [label, setLabel] = useState('')
  const [target, setTarget] = useState('')
  const [error, setError] = useState<string | null>(null)

  const save = useMutation({
    mutationFn: () => api.post('/staff/targets', { label, target: Number(target) }),
    onSuccess: () => {
      setEditing(false)
      setError(null)
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save that target'),
  })

  const m = dashboard.data?.milestone
  const pct = m ? Math.min(100, Math.round((m.actual / Math.max(m.target, 1)) * 100)) : 0

  function startEditing() {
    setLabel(m?.label ?? 'Q4 milestone')
    setTarget(String(m?.target ?? 50))
    setEditing(true)
  }

  return (
    <div className="card card-pad">
      <div className="row between" style={{ marginBottom: 10 }}>
        <div className="row" style={{ gap: 9 }}>
          <span className="k-ic"><Target size={15} /></span>
          <div className="stack">
            <span className="ch-t">{m?.label ?? 'Milestone'}</span>
            <span className="ch-s">Company-wide. Everyone sees the same progress.</span>
          </div>
        </div>
        {!editing && (
          <button className="btn btn--secondary btn--sm" onClick={startEditing}>
            Change target
          </button>
        )}
      </div>

      {error && <div className="notice-error">{error}</div>}

      {editing ? (
        <form
          onSubmit={(e) => { e.preventDefault(); setError(null); save.mutate() }}
        >
          <div className="invite-grid">
            <div className="field">
              <label htmlFor="t-label">Label</label>
              <input id="t-label" value={label} onChange={(e) => setLabel(e.target.value)} required />
            </div>
            <div className="field">
              <label htmlFor="t-target">Merchants on Mesa</label>
              <input
                id="t-target" type="number" min={1} inputMode="numeric"
                value={target} onChange={(e) => setTarget(e.target.value)} required
              />
            </div>
          </div>
          <div className="row" style={{ gap: 8 }}>
            <button className="btn btn--primary btn--sm" type="submit" disabled={save.isPending}>
              {save.isPending ? 'Saving…' : 'Save target'}
            </button>
            <button className="btn btn--secondary btn--sm" type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
          </div>
          <p className="hint" style={{ marginTop: 10 }}>
            The previous target is kept, not overwritten, so past charts still
            know what “on plan” meant at the time.
          </p>
        </form>
      ) : (
        <>
          <span className="num" style={{ fontSize: 32, display: 'block', marginBottom: 10 }}>
            {m?.actual ?? 0}<small> / {m?.target ?? 0}</small>
          </span>
          <div className="m-bar" style={{ background: 'var(--cream-200)' }}>
            <i style={{ width: `${pct}%` }} />
          </div>
          <span className="k-note" style={{ marginTop: 8, display: 'block' }}>{pct}% there</span>
        </>
      )}
    </div>
  )
}

function InviteForm({
  allowedRoles,
  onDone,
  onCancel,
}: {
  allowedRoles: string[]
  onDone: (r: { name: string; email: string; password: string }) => void
  onCancel: () => void
}) {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [role, setRole] = useState(allowedRoles.includes('member') ? 'member' : allowedRoles[0])
  const [refCode, setRefCode] = useState('')
  const [error, setError] = useState<string | null>(null)

  const invite = useMutation({
    mutationFn: () =>
      api.post<Wrapped<{ name: string; email: string; tempPassword: string }>>('/staff/team', {
        name, email, role, refCode: refCode || undefined,
      }),
    onSuccess: (r) => onDone({ name: r.data.name, email: r.data.email, password: r.data.tempPassword }),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create that account'),
  })

  return (
    <form
      className="card card-pad"
      onSubmit={(e) => { e.preventDefault(); setError(null); invite.mutate() }}
    >
      <div className="row between" style={{ marginBottom: 14 }}>
        <span className="ch-t">Invite someone</span>
        <button type="button" className="icon-btn" onClick={onCancel} aria-label="Cancel">
          <X size={16} />
        </button>
      </div>

      {error && <div className="notice-error">{error}</div>}

      <div className="invite-grid">
        <div className="field">
          <label htmlFor="iv-name">Name</label>
          <input id="iv-name" value={name} onChange={(e) => setName(e.target.value)} autoCapitalize="words" required />
        </div>
        <div className="field">
          <label htmlFor="iv-email">Email</label>
          <input id="iv-email" type="email" inputMode="email" autoCapitalize="none"
            value={email} onChange={(e) => setEmail(e.target.value)} required />
        </div>
        <div className="field">
          <label htmlFor="iv-role">Role</label>
          <select id="iv-role" value={role} onChange={(e) => setRole(e.target.value)}>
            {allowedRoles.map((r) => <option key={r} value={r}>{r}</option>)}
          </select>
          {!allowedRoles.includes('admin') && (
            <div className="hint">Only an admin can invite another admin or a manager.</div>
          )}
        </div>
        <div className="field">
          <label htmlFor="iv-ref">Ref code <span style={{ fontWeight: 400, textTransform: 'none', letterSpacing: 0 }}>(optional)</span></label>
          <input id="iv-ref" value={refCode} maxLength={6}
            onChange={(e) => setRefCode(e.target.value.toUpperCase())} placeholder="TB" />
          <div className="hint">Goes on their signup links so their merchants attribute back to them.</div>
        </div>
      </div>

      <button className="btn btn--primary" type="submit" disabled={invite.isPending}>
        {invite.isPending ? 'Creating…' : 'Create account'}
      </button>
    </form>
  )
}

/**
 * The temporary password, shown once.
 *
 * There is no email delivery yet, so this is the only time it is visible and
 * the only way it reaches the person. Making that explicit beats letting
 * someone dismiss it and discover later that it is unrecoverable — the reset
 * button on their row is the way out, and it is worth saying so here.
 */
function TempPasswordNotice({
  issued,
  onDismiss,
}: {
  issued: { name: string; email: string; password: string }
  onDismiss: () => void
}) {
  const [copied, setCopied] = useState(false)

  return (
    <div className="card card-pad temp-pw">
      <div className="row between">
        <span className="ch-t">Temporary password for {issued.name}</span>
        <button className="icon-btn" onClick={onDismiss} aria-label="Dismiss">
          <X size={16} />
        </button>
      </div>
      <p className="section-note" style={{ margin: '6px 0 12px' }}>
        Shown once and not recoverable. Send it to {issued.email} yourself. They
        must change it when they first sign in. If it gets lost, use the key
        button on their row to issue a new one.
      </p>
      <div className="pw-row">
        <code>{issued.password}</code>
        <button
          className="btn btn--secondary btn--sm"
          onClick={() => {
            navigator.clipboard?.writeText(issued.password)
            setCopied(true)
            setTimeout(() => setCopied(false), 2000)
          }}
        >
          {copied ? <Check size={14} /> : <Copy size={14} />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  )
}
