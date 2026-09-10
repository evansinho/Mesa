import { useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import { Upload, ClipboardPaste } from 'lucide-react'
import {
  api, ApiError,
  type ImportPlan, type ImportSkipReason, type ProspectSource, type Wrapped,
} from '../lib/api'

const SOURCES: { value: ProspectSource; label: string }[] = [
  { value: 'outbound', label: 'Outbound' },
  { value: 'instagram', label: 'Instagram' },
  { value: 'whatsapp', label: 'WhatsApp' },
  { value: 'referral', label: 'Referral' },
  { value: 'partnership', label: 'Partnership' },
  { value: 'event', label: 'Event' },
  { value: 'inbound', label: 'Inbound' },
  { value: 'organic', label: 'Organic' },
]

// Phrased as what happened to the row, so the operator can tell at a glance
// which skips are fine (already ours) and which are a problem with the file.
const SKIP_LABELS: Record<ImportSkipReason, string> = {
  already_a_merchant: 'Already a customer',
  already_a_prospect: 'Already a prospect',
  duplicate_in_file: 'Repeated in this file',
  bad_phone: 'Unusable number',
  no_business_name: 'No business name',
}

const SKIP_ORDER: ImportSkipReason[] = [
  'already_a_merchant', 'already_a_prospect', 'duplicate_in_file',
  'bad_phone', 'no_business_name',
]

export default function ImportProspectsPage() {
  const navigate = useNavigate()
  const qc = useQueryClient()
  const fileInput = useRef<HTMLInputElement>(null)

  const [text, setText] = useState('')
  const [fileName, setFileName] = useState<string | null>(null)
  const [source, setSource] = useState<ProspectSource>('outbound')
  const [sourceDetail, setSourceDetail] = useState('')
  const [claim, setClaim] = useState(true)
  const [plan, setPlan] = useState<ImportPlan | null>(null)
  const [done, setDone] = useState<ImportPlan | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  async function readFile(file: File) {
    setFileName(file.name)
    setText(await file.text())
    // A new file invalidates the preview. Leaving the old one on screen while
    // the textarea holds different content is how someone commits the wrong list.
    setPlan(null)
    setError(null)
  }

  async function send(dryRun: boolean) {
    setBusy(true)
    setError(null)
    try {
      const res = await api.post<Wrapped<ImportPlan>>('/staff/prospects/import', {
        text,
        source,
        sourceDetail: sourceDetail || undefined,
        ownerId: claim ? undefined : null,
        dryRun,
      })
      if (dryRun) setPlan(res.data)
      else {
        setDone(res.data)
        setPlan(null)
        await qc.invalidateQueries({ queryKey: ['prospects'] })
        qc.invalidateQueries({ queryKey: ['dashboard'] })
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Could not read that list')
    } finally {
      setBusy(false)
    }
  }

  if (done) {
    const created = done.created?.length ?? 0
    return (
      <main className="page">
        <h2 style={{ fontSize: 19, marginBottom: 14 }}>Imported</h2>
        <div className="card card-pad">
          <p style={{ margin: 0 }}>
            <strong>{created}</strong> prospect{created === 1 ? '' : 's'} added
            {claim ? ', assigned to you' : ', left unclaimed for the team'}.
          </p>
          {done.skip.length > 0 && (
            <p className="meta" style={{ marginBottom: 0 }}>
              {done.skip.length} row{done.skip.length === 1 ? '' : 's'} skipped.
            </p>
          )}
        </div>
        <div className="row" style={{ gap: 10, marginTop: 14 }}>
          <button className="btn btn--primary" onClick={() => navigate({ to: '/prospects' })}>
            See prospects
          </button>
          <button
            className="btn btn--secondary"
            onClick={() => { setDone(null); setText(''); setFileName(null) }}
          >
            Import another
          </button>
        </div>
      </main>
    )
  }

  return (
    <main className="page">
      <h2 style={{ fontSize: 19, marginBottom: 4 }}>Import prospects</h2>
      <p className="section-note" style={{ marginTop: 0 }}>
        Paste a range from a spreadsheet, or pick a CSV. Needs a phone column;
        a business name column too. Anything else is ignored.
      </p>

      {error && <div className="notice-error">{error}</div>}

      <div className="field">
        <label htmlFor="src">Where did these come from?</label>
        <select id="src" value={source} onChange={(e) => { setSource(e.target.value as ProspectSource); setPlan(null) }}>
          {SOURCES.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
        </select>
        <div className="hint">
          Applies to the whole list and can’t be changed later. It’s how we tell
          which channels work. A <span className="mono">notes</span> column in
          the sheet overrides the detail below, row by row.
        </div>
      </div>

      <div className="field">
        <label htmlFor="detail">Source detail <span style={{ fontWeight: 400 }}>(optional)</span></label>
        <input
          id="detail"
          placeholder="where the list came from"
          value={sourceDetail}
          onChange={(e) => setSourceDetail(e.target.value)}
        />
      </div>

      <div className="field">
        <label>Who works these?</label>
        <div className="chip-row">
          <button
            type="button"
            className={`btn btn--sm ${claim ? 'btn--primary' : 'btn--secondary'}`}
            onClick={() => setClaim(true)}
          >
            Assign to me
          </button>
          <button
            type="button"
            className={`btn btn--sm ${claim ? 'btn--secondary' : 'btn--primary'}`}
            onClick={() => setClaim(false)}
          >
            Leave unclaimed
          </button>
        </div>
      </div>

      <div className="field">
        <label htmlFor="paste">
          <ClipboardPaste size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
          The list
        </label>
        <textarea
          id="paste"
          rows={8}
          value={text}
          onChange={(e) => { setText(e.target.value); setPlan(null) }}
          placeholder={'business_name\tphone\nMama Ronke Kitchen\t08031234567'}
          style={{ fontFamily: 'var(--font-mono)', fontSize: 13, width: '100%' }}
        />
        <div className="row" style={{ gap: 10, marginTop: 8, alignItems: 'center' }}>
          <button type="button" className="btn btn--secondary btn--sm" onClick={() => fileInput.current?.click()}>
            <Upload size={13} style={{ verticalAlign: -2, marginRight: 5 }} />
            Choose a CSV
          </button>
          {fileName && <span className="meta mono truncate">{fileName}</span>}
          <input
            ref={fileInput}
            type="file"
            accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
            style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) void readFile(f) }}
          />
        </div>
      </div>

      {/* Preview before write, always. This lands straight in the table the
          team works out of and there is no undo. */}
      {!plan ? (
        <button
          className="btn btn--primary wide"
          disabled={busy || text.trim().length === 0}
          onClick={() => void send(true)}
        >
          {busy ? 'Checking…' : 'Check the list'}
        </button>
      ) : (
        <ImportPreview
          plan={plan}
          busy={busy}
          onConfirm={() => void send(false)}
          onBack={() => setPlan(null)}
        />
      )}
    </main>
  )
}

function ImportPreview({ plan, busy, onConfirm, onBack }: {
  plan: ImportPlan
  busy: boolean
  onConfirm: () => void
  onBack: () => void
}) {
  const skipsByReason = SKIP_ORDER
    .map((reason) => ({ reason, rows: plan.skip.filter((s) => s.reason === reason) }))
    .filter((g) => g.rows.length > 0)

  return (
    <>
      <div className="card card-pad" style={{ marginBottom: 14 }}>
        <div className="section-title">What this will do</div>
        {/* Absolute counts out of the total, not bare percentages — at these
            row counts a percentage hides how small the numbers are. */}
        <p style={{ margin: '8px 0 0' }}>
          <strong>{plan.counts.create}</strong> of {plan.counts.total} row
          {plan.counts.total === 1 ? '' : 's'} will be added.
        </p>
        {skipsByReason.length > 0 && (
          <div style={{ marginTop: 10 }}>
            {skipsByReason.map(({ reason, rows }) => (
              <div className="kv-row" key={reason}>
                <span className="kv-k">{SKIP_LABELS[reason]}</span>
                <span className="kv-v mono">{rows.length}</span>
              </div>
            ))}
          </div>
        )}
        {plan.parseErrors.length > 0 && (
          <p className="meta" style={{ marginBottom: 0 }}>
            {plan.parseErrors.length} line{plan.parseErrors.length === 1 ? '' : 's'} could not be
            read: {plan.parseErrors.slice(0, 3).map((e) => `line ${e.line}`).join(', ')}
            {plan.parseErrors.length > 3 ? '…' : ''}
          </p>
        )}
      </div>

      {plan.counts.already_a_merchant > 0 && (
        // The one skip worth calling out on its own: importing these would put
        // existing customers into the outbound pipeline for someone to cold-call.
        <div className="notice-info">
          {plan.counts.already_a_merchant} of these {plan.counts.already_a_merchant === 1 ? 'is' : 'are'} already
          on Mesa as {plan.counts.already_a_merchant === 1 ? 'a customer' : 'customers'}, so
          {plan.counts.already_a_merchant === 1 ? ' it is' : ' they are'} left out.
        </div>
      )}

      {plan.create.length > 0 && (
        <div className="card tbl-wrap" style={{ marginBottom: 14 }}>
          <table className="tbl">
            <thead>
              <tr><th>Will be added</th><th>Number</th></tr>
            </thead>
            <tbody>
              {plan.create.slice(0, 50).map((r) => (
                <tr key={`${r.line}-${r.phoneNormalized}`}>
                  <td className="truncate">{r.businessName}</td>
                  <td className="mono meta">{r.phoneNormalized}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.create.length > 50 && (
            <div className="section-note" style={{ padding: 'var(--space-3)' }}>
              Showing the first 50 of {plan.create.length}. All of them will be added.
            </div>
          )}
        </div>
      )}

      {plan.skip.length > 0 && (
        <div className="card tbl-wrap" style={{ marginBottom: 14 }}>
          <table className="tbl">
            <thead>
              <tr><th>Skipped</th><th>Number</th><th>Why</th></tr>
            </thead>
            <tbody>
              {plan.skip.slice(0, 50).map((r, i) => (
                <tr key={`${r.line}-${i}`}>
                  <td className="truncate">{r.businessName ?? <span className="subtle">no name</span>}</td>
                  <td className="mono meta">{r.phoneNormalized ?? r.phone}</td>
                  <td className="meta">
                    {SKIP_LABELS[r.reason]}
                    {r.detail ? <span className="subtle"> · {r.detail}</span> : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {plan.skip.length > 50 && (
            <div className="section-note" style={{ padding: 'var(--space-3)' }}>
              Showing the first 50 of {plan.skip.length}.
            </div>
          )}
        </div>
      )}

      <div className="row" style={{ gap: 10 }}>
        <button
          className="btn btn--primary"
          disabled={busy || plan.counts.create === 0}
          onClick={onConfirm}
        >
          {busy
            ? 'Importing…'
            : plan.counts.create === 0
              ? 'Nothing to add'
              : `Add ${plan.counts.create} prospect${plan.counts.create === 1 ? '' : 's'}`}
        </button>
        <button className="btn btn--secondary" disabled={busy} onClick={onBack}>
          Back
        </button>
      </div>
    </>
  )
}
