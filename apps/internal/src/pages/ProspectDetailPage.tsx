import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { Phone, MessageCircle, Presentation, StickyNote, Users, Send } from 'lucide-react'
import { api, ApiError, type Activity, type Prospect, type ProspectStage, type Wrapped } from '../lib/api'
import { getSession, isManager } from '../lib/auth'
import StageBadge from '../components/StageBadge'

const STAGES: ProspectStage[] = ['SOURCED', 'CONTACTED', 'DEMOED', 'DORMANT']

const ACTIVITY_TYPES = [
  { value: 'note', label: 'Note', icon: StickyNote },
  { value: 'call', label: 'Call', icon: Phone },
  { value: 'whatsapp', label: 'WhatsApp', icon: MessageCircle },
  { value: 'demo', label: 'Demo', icon: Presentation },
  { value: 'meeting', label: 'Meeting', icon: Users },
] as const

const DISQUALIFY_REASONS = [
  'NOT_A_SELLER', 'NO_WHATSAPP_ORDERS', 'TOO_LARGE', 'PRICE',
  'NO_RESPONSE', 'DUPLICATE', 'COMPETITOR', 'OTHER',
] as const

export default function ProspectDetailPage() {
  // Route *id*, not path: children of the pathless `app` layout route are
  // registered under an /app prefix even though their URL has none.
  const { id } = useParams({ from: '/app/prospects/$id' })
  const qc = useQueryClient()
  const session = getSession()

  const [draft, setDraft] = useState('')
  const [type, setType] = useState<(typeof ACTIVITY_TYPES)[number]['value']>('note')
  const [error, setError] = useState<string | null>(null)
  const [showDisqualify, setShowDisqualify] = useState(false)

  const prospect = useQuery({
    queryKey: ['prospects', id],
    queryFn: () => api.get<Wrapped<Prospect>>(`/staff/prospects/${id}`).then((r) => r.data),
  })

  const activities = useQuery({
    queryKey: ['prospects', id, 'activities'],
    queryFn: () => api.get<Wrapped<Activity[]>>(`/staff/prospects/${id}/activities`).then((r) => r.data),
  })

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['prospects', id] })
    qc.invalidateQueries({ queryKey: ['prospects'] })
  }

  const logActivity = useMutation({
    mutationFn: (body: string) =>
      api.post(`/staff/prospects/${id}/activities`, { type, body }),
    onSuccess: () => {
      setDraft('')
      setError(null)
      qc.invalidateQueries({ queryKey: ['prospects', id, 'activities'] })
    },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not log that'),
  })

  const setStage = useMutation({
    mutationFn: (stage: ProspectStage) => api.patch(`/staff/prospects/${id}`, { stage }),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not update stage'),
  })

  const claim = useMutation({
    mutationFn: () => api.post(`/staff/prospects/${id}/claim`),
    onSuccess: invalidate,
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not claim'),
  })

  const disqualify = useMutation({
    mutationFn: (payload: { reason: string; note?: string }) =>
      api.post(`/staff/prospects/${id}/disqualify`, payload),
    onSuccess: () => { setShowDisqualify(false); invalidate() },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not disqualify'),
  })

  if (prospect.isLoading) {
    return <div className="page"><div className="skeleton" /><div className="skeleton" /></div>
  }
  if (prospect.error) {
    return <div className="page"><div className="error">{(prospect.error as Error).message}</div></div>
  }

  const p = prospect.data!
  const onMesa = Boolean(p.merchantId)

  return (
    <div className="page">
      {error && <div className="error">{error}</div>}

      <div className="card">
        <div className="row between" style={{ marginBottom: 8 }}>
          <h2 style={{ fontSize: 19 }}>{p.businessName}</h2>
          <StageBadge prospect={p} />
        </div>
        <div className="stack">
          <a className="mono" href={`https://wa.me/${p.phoneNormalized.replace('+', '')}`}>
            {p.phoneNormalized}
          </a>
          {p.contactName && <span className="meta">{p.contactName}</span>}
          {p.instagramHandle && <span className="meta">{p.instagramHandle}</span>}
          <span className="meta">
            {p.source}{p.sourceDetail ? ` · ${p.sourceDetail}` : ''}
            {' · '}
            {p.owner ? p.owner.name : 'unclaimed'}
          </span>
        </div>

        {p.ownerId === null && (
          <button
            className="btn wide"
            style={{ marginTop: 12 }}
            onClick={() => claim.mutate()}
            disabled={claim.isPending}
          >
            {claim.isPending ? 'Claiming…' : 'Claim this prospect'}
          </button>
        )}
      </div>

      {onMesa ? (
        <div className="notice">
          Signed up on Mesa{p.matchedAt ? ` · matched ${p.matchStatus}` : ''}. Their stage is now
          worked out from what they actually do in the product, not set by hand.
        </div>
      ) : (
        <div className="card">
          <label style={{ fontSize: 12, fontWeight: 600, color: 'var(--muted)' }}>Stage</label>
          <div className="type-picker" style={{ paddingBottom: 0, marginTop: 6 }}>
            {STAGES.map((s) => (
              <button
                key={s}
                data-on={p.stage === s}
                onClick={() => setStage.mutate(s)}
                disabled={setStage.isPending}
              >
                {s.charAt(0) + s.slice(1).toLowerCase()}
              </button>
            ))}
          </div>

          {isManager(session) && p.stage !== 'DISQUALIFIED' && (
            <button
              className="btn ghost wide"
              style={{ marginTop: 12 }}
              onClick={() => setShowDisqualify((v) => !v)}
            >
              Disqualify
            </button>
          )}

          {showDisqualify && (
            <DisqualifyForm
              busy={disqualify.isPending}
              onSubmit={(reason, note) => disqualify.mutate({ reason, note })}
            />
          )}
        </div>
      )}

      {p.stage === 'DISQUALIFIED' && (
        <div className="card">
          <span className="meta">
            Disqualified — {p.disqualifyReason}
            {p.disqualifyNote ? `: ${p.disqualifyNote}` : ''}
          </span>
        </div>
      )}

      <h3 style={{ fontSize: 15, margin: '18px 0 8px' }}>Activity</h3>

      <div className="card">
        {activities.isLoading ? (
          <div className="skeleton" style={{ height: 40 }} />
        ) : (activities.data?.length ?? 0) === 0 ? (
          <span className="meta">Nothing logged yet.</span>
        ) : (
          activities.data!.map((a) => {
            const Icon = ACTIVITY_TYPES.find((t) => t.value === a.type)?.icon ?? StickyNote
            return (
              <div className="feed-item" key={a.id}>
                <div className="feed-icon"><Icon size={15} /></div>
                <div className="stack" style={{ flex: 1 }}>
                  <span>{a.body}</span>
                  <span className="meta">
                    {a.staffName ?? 'Unknown'} · {new Date(a.occurredAt).toLocaleString()}
                  </span>
                </div>
              </div>
            )
          })
        )}
      </div>

      <div className="type-picker">
        {ACTIVITY_TYPES.map((t) => (
          <button key={t.value} data-on={type === t.value} onClick={() => setType(t.value)}>
            {t.label}
          </button>
        ))}
      </div>

      <div className="composer">
        <textarea
          placeholder="What happened?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            // Enter sends, shift+enter newlines — the whole point is that
            // logging costs a few seconds.
            if (e.key === 'Enter' && !e.shiftKey && draft.trim()) {
              e.preventDefault()
              logActivity.mutate(draft.trim())
            }
          }}
        />
        <button
          className="send"
          aria-label="Log activity"
          disabled={!draft.trim() || logActivity.isPending}
          onClick={() => logActivity.mutate(draft.trim())}
        >
          <Send size={17} />
        </button>
      </div>
    </div>
  )
}

function DisqualifyForm({
  busy,
  onSubmit,
}: {
  busy: boolean
  onSubmit: (reason: string, note?: string) => void
}) {
  const [reason, setReason] = useState<string>(DISQUALIFY_REASONS[0])
  const [note, setNote] = useState('')
  const noteRequired = reason === 'OTHER'

  return (
    <div style={{ marginTop: 12 }}>
      <div className="field">
        <label htmlFor="reason">Reason</label>
        <select id="reason" value={reason} onChange={(e) => setReason(e.target.value)}>
          {DISQUALIFY_REASONS.map((r) => (
            <option key={r} value={r}>{r.replace(/_/g, ' ').toLowerCase()}</option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="note">Note {noteRequired && <span style={{ color: 'var(--danger)' }}>*</span>}</label>
        <input id="note" value={note} onChange={(e) => setNote(e.target.value)} />
        {noteRequired && <div className="hint">Required when the reason is “other”.</div>}
      </div>
      <button
        className="btn danger wide"
        disabled={busy || (noteRequired && !note.trim())}
        onClick={() => onSubmit(reason, note.trim() || undefined)}
      >
        {busy ? 'Saving…' : 'Confirm disqualify'}
      </button>
    </div>
  )
}
