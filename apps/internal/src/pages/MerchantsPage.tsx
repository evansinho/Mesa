import { useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Search, AlertTriangle } from 'lucide-react'
import { naira } from '../components/charts'
import MerchantDrawer from '../components/MerchantDrawer'
import {
  fetchMerchants, initials, relative, STAGE_LABELS, STAGE_TONE,
} from '../lib/merchants'

export default function MerchantsPage() {
  const [q, setQ] = useState('')
  const [openId, setOpenId] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery({
    queryKey: ['merchants', q],
    queryFn: () => fetchMerchants(q || undefined),
    // Hold the previous rows while a new search resolves. Swapping to a
    // skeleton on every keystroke makes the table flash and the page jump.
    placeholderData: (prev) => prev,
  })

  const rows = data ?? []

  return (
    <main className="page">
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search merchant or source…"
            aria-label="Search merchants"
          />
        </div>
        <span className="mono">{rows.length} merchants</span>
      </div>

      {error ? (
        <div className="notice-error">{(error as Error).message}</div>
      ) : isLoading ? (
        <div className="skeleton" style={{ height: 260 }} />
      ) : rows.length === 0 ? (
        <div className="card"><div className="empty">No merchants match that search.</div></div>
      ) : (
        <div className="card tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Merchant</th>
                <th>Stage</th>
                <th>Owner</th>
                <th className="n">MRR</th>
                <th className="n">Orders · 30d</th>
                <th className="n">Activation</th>
                <th className="n">Last activity</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((m) => (
                <tr
                  key={m.id}
                  tabIndex={0}
                  role="button"
                  onClick={() => setOpenId(m.id)}
                  onKeyDown={(e) => {
                    // Clickable rows need keyboard activation, not just a
                    // hover affordance.
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      setOpenId(m.id)
                    }
                  }}
                >
                  <td>
                    <div className="row" style={{ gap: 11 }}>
                      <span className="avatar">{initials(m.name)}</span>
                      <div className="stack" style={{ minWidth: 0 }}>
                        <span className="queue-name truncate">{m.name}</span>
                        <span className="lb-sub truncate">
                          {m.source ?? '—'}
                          {m.sourceDetail ? ` · ${m.sourceDetail}` : ''}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td>
                    <span className={`badge badge--${STAGE_TONE[m.displayStage]}`}>
                      <span className="badge__dot" />
                      {STAGE_LABELS[m.displayStage] ?? m.displayStage}
                    </span>
                    {/* Risk rides alongside the stage rather than replacing it,
                        so a quiet merchant still reads as paying. */}
                    {m.risk && (
                      <span className="risk-flag" title={m.risk}>
                        <AlertTriangle size={12} />
                      </span>
                    )}
                  </td>
                  <td className="meta">{m.owner?.name ?? '—'}</td>
                  <td className="n-strong">
                    {m.mrr > 0 ? naira(m.mrr) : <span className="subtle">—</span>}
                  </td>
                  <td className="n">{m.orders30d}</td>
                  <td className="n">
                    {m.activationDays === null ? <span className="subtle">—</span> : `${m.activationDays}d`}
                  </td>
                  <td className="n meta">{relative(m.lastActivityAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <MerchantDrawer merchantId={openId} onClose={() => setOpenId(null)} />
    </main>
  )
}
