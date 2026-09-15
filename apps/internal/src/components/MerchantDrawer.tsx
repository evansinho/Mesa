import { useEffect, useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { X, AlertTriangle, Check, MessageCircle, Lock } from 'lucide-react'
import { api, ApiError, type Wrapped } from '../lib/api'
import { getSession, isAdmin, isManager } from '../lib/auth'
import { naira } from './charts'
import { STAGE_LABELS, STAGE_TONE, type Merchant } from '../lib/merchants'

type Detail = Merchant & {
  timeline: { state: string; occurredAt: string; ruleVersion: number }[]
  activities: { id: string; type: string; body: string; occurredAt: string; staffName: string | null }[]
}

// The rail the timeline is drawn against. Every merchant walks the same path,
// so future steps are shown greyed rather than hidden — "what hasn't happened
// yet" is the useful half for a rep looking at a stalled account.
const LIFECYCLE_STEPS = [
  { state: 'SIGNED_UP', title: 'Signed up', sub: 'Merchant account created' },
  { state: 'CONNECTED', title: 'WhatsApp connected', sub: 'Mesa can see their conversations' },
  { state: 'FIRST_VALUE', title: 'First order booked', sub: 'An order got past detection' },
  { state: 'FIRST_PAYMENT', title: 'First payment confirmed', sub: 'A transfer was matched' },
  { state: 'ACTIVATED', title: 'Activated', sub: 'Using Mesa habitually' },
  { state: 'PAYING', title: 'Paying', sub: 'On an active plan' },
] as const

function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('')
}

function when(iso: string | null): string {
  if (!iso) return '—'
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })
}

export default function MerchantDrawer({
  merchantId,
  onClose,
}: {
  merchantId: string | null
  onClose: () => void
}) {
  const qc = useQueryClient()
  const session = getSession()
  const [ownerError, setOwnerError] = useState<string | null>(null)

  // Manager+ only, and the same list the prospect record uses.
  const team = useQuery({
    queryKey: ['team'],
    queryFn: () =>
      api
        .get<{ data: { id: string; name: string; role: string; active: boolean }[] }>('/staff/team')
        .then((r) => r.data),
    enabled: isManager(session),
  })

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['merchants'] })
    qc.invalidateQueries({ queryKey: ['queue'] })
    qc.invalidateQueries({ queryKey: ['dashboard'] })
  }

  const assign = useMutation({
    mutationFn: (ownerId: string | null) =>
      api.patch(`/staff/merchants/${merchantId}/owner`, { ownerId }),
    onSuccess: () => { setOwnerError(null); refresh() },
    onError: (e) => setOwnerError(e instanceof ApiError ? e.message : 'Could not reassign'),
  })

  const claim = useMutation({
    mutationFn: () => api.post(`/staff/merchants/${merchantId}/claim`),
    onSuccess: () => { setOwnerError(null); refresh() },
    onError: (e) => setOwnerError(e instanceof ApiError ? e.message : 'Could not claim'),
  })

  const [testAccountError, setTestAccountError] = useState<string | null>(null)
  const markTestAccount = useMutation({
    mutationFn: (next: boolean) =>
      api.patch(`/staff/merchants/${merchantId}/test-account`, { isTestAccount: next }),
    onSuccess: () => { setTestAccountError(null); refresh() },
    onError: (e) => setTestAccountError(e instanceof ApiError ? e.message : 'Could not update'),
  })

  const { data, isLoading } = useQuery({
    // Namespaced: ['merchants', <search>] is the LIST and returns an array,
    // ['merchants', 'detail', <id>] is one record. Sharing a prefix without a
    // discriminator is how the dashboard key broke.
    queryKey: ['merchants', 'detail', merchantId],
    queryFn: () =>
      api.get<Wrapped<Detail>>(`/staff/merchants/${merchantId}`).then((r) => r.data),
    enabled: merchantId !== null,
  })

  // Escape closes. A panel that can only be dismissed by hitting a 34px target
  // is a panel people feel trapped in.
  useEffect(() => {
    if (!merchantId) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [merchantId, onClose])

  if (!merchantId) return null

  const m = data
  const reached = new Set(m?.timeline.map((t) => t.state) ?? [])
  const stampedAt = new Map(m?.timeline.map((t) => [t.state, t.occurredAt]) ?? [])

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-label={m?.name ?? 'Merchant record'}>
        <header className="dr-head">
          <button className="dr-close" onClick={onClose} aria-label="Close">
            <X size={16} />
          </button>

          {isLoading || !m ? (
            <div className="skeleton" style={{ height: 80, background: 'rgba(255,255,255,.08)' }} />
          ) : (
            <>
              <div className="dr-id">
                <span className="dr-av">{initials(m.name)}</span>
                <div className="stack" style={{ minWidth: 0 }}>
                  <span className="dr-name">{m.name}</span>
                  <span className="dr-sub">
                    {m.phone}
                    {m.source ? ` · ${m.source}` : ''}
                    {m.sourceDetail ? ` · ${m.sourceDetail}` : ''}
                  </span>
                </div>
              </div>

              <span className={`badge badge--${STAGE_TONE[m.displayStage]} dr-badge`}>
                <span className="badge__dot" />
                {STAGE_LABELS[m.displayStage] ?? m.displayStage}
              </span>

              <div className="dr-stats">
                <div>
                  <span className="dr-slab">MRR</span>
                  <span className="num dr-sval">{m.mrr > 0 ? naira(m.mrr) : '—'}</span>
                </div>
                <div>
                  <span className="dr-slab">Orders · 30d</span>
                  <span className="num dr-sval">{m.orders30d}</span>
                </div>
                <div>
                  <span className="dr-slab">Activation</span>
                  <span className="num dr-sval">
                    {m.activationDays === null ? '—' : <>{m.activationDays}<small>d</small></>}
                  </span>
                </div>
              </div>
            </>
          )}
        </header>

        <div className="dr-body">
          {m?.risk && (
            <div className="dr-risk">
              <AlertTriangle size={16} />
              <span><b>Needs attention.</b> {m.risk}</span>
            </div>
          )}

          <section>
            <h3 className="dr-sec">Account</h3>
            {ownerError && <div className="notice-error">{ownerError}</div>}

            {/* Owning a merchant means owning its attribution record. A
                self-serve signup has none, so claiming creates one — which is
                why this is an action rather than a read-only row. */}
            {isManager(session) ? (
              <div className="field" style={{ marginBottom: 12 }}>
                <label htmlFor="m-owner">Owner rep</label>
                <select
                  id="m-owner"
                  value={m?.owner?.id ?? ''}
                  disabled={assign.isPending || team.isLoading}
                  onChange={(e) => assign.mutate(e.target.value || null)}
                >
                  <option value="">Unclaimed (anyone can take it)</option>
                  {(team.data ?? []).filter((t) => t.active).map((t) => (
                    <option key={t.id} value={t.id}>{t.name} · {t.role}</option>
                  ))}
                </select>
              </div>
            ) : (
              !m?.owner && (
                <button
                  className="btn btn--primary btn--sm wide"
                  style={{ marginBottom: 12 }}
                  onClick={() => claim.mutate()}
                  disabled={claim.isPending}
                >
                  {claim.isPending ? 'Claiming…' : 'Claim this merchant'}
                </button>
              )
            )}

            <div className="card dr-kv">
              <Row k="Owner rep" v={m?.owner?.name ?? 'Unclaimed'} />
              <Row k="Plan" v={m ? m.tier : '—'} />
              <Row k="Billing" v={m ? m.subscriptionStatus.replace('_', ' ') : '—'} />
              <Row k="Source" v={m?.source ?? '—'} />
              <Row k="Customer since" v={when(m?.createdAt ?? null)} />
              <Row k="Connected" v={when(m?.connectedAt ?? null)} />
              {m?.isTestAccount && <Row k="Test account" v="Yes — excluded from milestone/MRR" />}
            </div>

            {/* Excludes the merchant from the company milestone and MRR — a
                metrics-integrity lever, so only an admin can flip it, matching
                the merchant:mark-test permission the endpoint itself enforces. */}
            {isAdmin(session) && m && (
              <>
                {testAccountError && <div className="notice-error">{testAccountError}</div>}
                <button
                  className="btn btn--secondary btn--sm wide"
                  style={{ marginTop: 10 }}
                  onClick={() => markTestAccount.mutate(!m.isTestAccount)}
                  disabled={markTestAccount.isPending}
                >
                  {markTestAccount.isPending
                    ? 'Updating…'
                    : m.isTestAccount ? 'Unmark as test account' : 'Mark as test account'}
                </button>
              </>
            )}
          </section>

          <section>
            <h3 className="dr-sec">Lifecycle</h3>
            <div className="notice-info">
              <Lock size={13} />
              Derived from product data. Not editable.
            </div>
            <div className="rail">
              {LIFECYCLE_STEPS.map((step) => {
                const done = reached.has(step.state)
                return (
                  <div className={`rail-item ${done ? 'is-done' : ''}`} key={step.state}>
                    <span className="rail-node">{done && <Check size={11} />}</span>
                    <div className="stack">
                      <span className="rail-t">{step.title}</span>
                      <span className="rail-s">
                        {done ? when(stampedAt.get(step.state) ?? null) : step.sub}
                      </span>
                    </div>
                  </div>
                )
              })}
              {/* The two exits only appear once reached; showing "Churned" as a
                  pending step on a healthy account would read as a forecast. */}
              {(['AT_RISK', 'CHURNED'] as const)
                .filter((s) => reached.has(s))
                .map((s) => (
                  <div className="rail-item is-exit" key={s}>
                    <span className="rail-node rail-node--exit" />
                    <div className="stack">
                      <span className="rail-t">{s === 'AT_RISK' ? 'Went quiet' : 'Churned'}</span>
                      <span className="rail-s">{when(stampedAt.get(s) ?? null)}</span>
                    </div>
                  </div>
                ))}
            </div>
          </section>

          {m && m.activities.length > 0 && (
            <section>
              <h3 className="dr-sec">Activity</h3>
              <div className="card" style={{ padding: '4px 15px' }}>
                {m.activities.map((a) => (
                  <div className="feed-item" key={a.id}>
                    <div className="stack" style={{ flex: 1 }}>
                      <span style={{ fontSize: 13.5 }}>{a.body}</span>
                      <span className="lb-sub">
                        {a.staffName ?? 'Unknown'} · {a.type} · {when(a.occurredAt)}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}
        </div>

        <footer className="dr-foot">
          <a
            className="btn btn--primary btn--sm"
            style={{ flex: 1 }}
            href={m ? `https://wa.me/${m.phone.replace('+', '')}` : undefined}
            target="_blank"
            rel="noreferrer"
          >
            <MessageCircle size={15} />
            Message on WhatsApp
          </a>
          {m?.prospectId && (
            <a className="btn btn--secondary btn--sm" style={{ flex: 1 }} href={`/prospects/${m.prospectId}`}>
              Log activity
            </a>
          )}
        </footer>
      </aside>
    </>
  )
}

function Row({ k, v }: { k: string; v: string }) {
  return (
    <div className="kv-row">
      <span className="kv-k">{k}</span>
      <span className="kv-v">{v}</span>
    </div>
  )
}
