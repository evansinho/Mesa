import { useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { Search } from 'lucide-react'
import type { Prospect, ProspectStage } from '../lib/api'
import { useProspects } from '../lib/prospects'
import { getSession, isManager } from '../lib/auth'
import { initials, relative } from '../lib/merchants'
import StageBadge from '../components/StageBadge'

// Funnel order, not alphabetical. ON_MESA is not a stage — it is the point the
// sales team hands over — so it sorts after the human-owned ladder, and the two
// endings sort last because they are outcomes rather than progress.
const ORDER: (ProspectStage | 'ON_MESA')[] = [
  'DEMOED', 'CONTACTED', 'SOURCED', 'ON_MESA', 'DORMANT', 'DISQUALIFIED',
]

const LABELS: Record<string, string> = {
  DEMOED: 'Demoed',
  CONTACTED: 'Contacted',
  SOURCED: 'Sourced',
  ON_MESA: 'On Mesa',
  DORMANT: 'Dormant',
  DISQUALIFIED: 'Disqualified',
}

function groupOf(p: Prospect): ProspectStage | 'ON_MESA' {
  return p.merchantId ? 'ON_MESA' : p.stage
}

export default function ProspectsPage() {
  const session = getSession()
  const navigate = useNavigate()
  const [q, setQ] = useState('')
  const { data, isLoading, error } = useProspects()

  if (isLoading) {
    return (
      <main className="page">
        <div className="skeleton" style={{ height: 260 }} />
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

  const all = data?.data ?? []
  const needle = q.trim().toLowerCase()

  const rows = all
    .filter(
      (p) =>
        !needle ||
        p.businessName.toLowerCase().includes(needle) ||
        p.source.toLowerCase().includes(needle) ||
        (p.sourceDetail ?? '').toLowerCase().includes(needle),
    )
    // One table sorted by funnel position, rather than a card per stage group.
    // Grouped cards left a single record floating in an empty column; a table
    // holds its shape whether there is one row or two hundred, and it reads the
    // same way Merchants already does.
    .sort((a, b) => {
      const d = ORDER.indexOf(groupOf(a)) - ORDER.indexOf(groupOf(b))
      return d !== 0 ? d : a.businessName.localeCompare(b.businessName)
    })

  const open = (id: string) => navigate({ to: '/prospects/$id', params: { id } })

  return (
    <main className="page">
      <div className="toolbar">
        <div className="search">
          <Search size={15} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search prospect or source…"
            aria-label="Search prospects"
          />
        </div>
        <span className="mono">
          {needle ? `${rows.length} of ${all.length}` : `${all.length} total`}
          {isManager(session) ? ' · whole team' : ' · yours and unclaimed'}
        </span>
        <div className="row" style={{ gap: 8, marginLeft: 'auto' }}>
          <a href="/prospects/import" className="btn btn--secondary btn--sm">Import</a>
          <a href="/prospects/new" className="btn btn--primary btn--sm">Add one</a>
        </div>
      </div>

      {all.length === 0 ? (
        <div className="card">
          <div className="empty">
            <p>No prospects yet.</p>
            <div className="row" style={{ gap: 10, marginTop: 12, justifyContent: 'center' }}>
              <a href="/prospects/import" className="btn btn--primary">Import a list</a>
              <a href="/prospects/new" className="btn btn--secondary">Add one</a>
            </div>
          </div>
        </div>
      ) : rows.length === 0 ? (
        <div className="card">
          <div className="empty">Nothing matches that search.</div>
        </div>
      ) : (
        <div className="card tbl-wrap">
          <table className="tbl">
            <thead>
              <tr>
                <th>Prospect</th>
                <th>Phone</th>
                <th>Stage</th>
                <th>Owner</th>
                <th className="n">Last touched</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((p) => (
                <tr
                  key={p.id}
                  tabIndex={0}
                  role="button"
                  onClick={() => open(p.id)}
                  onKeyDown={(e) => {
                    // Clickable rows need keyboard activation, not just a
                    // hover affordance.
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      open(p.id)
                    }
                  }}
                >
                  <td>
                    <div className="row" style={{ gap: 11 }}>
                      <span className="avatar">{initials(p.businessName)}</span>
                      <div className="stack" style={{ minWidth: 0 }}>
                        <span className="queue-name truncate">{p.businessName}</span>
                        <span className="lb-sub truncate">
                          {p.source}
                          {p.sourceDetail ? ` · ${p.sourceDetail}` : ''}
                        </span>
                      </div>
                    </div>
                  </td>
                  <td className="meta">
                    {/* Row click navigates to the detail page; stop that here
                        so the link opens WhatsApp instead. */}
                    <a
                      className="mono"
                      href={`https://wa.me/${p.phoneNormalized.replace('+', '')}`}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                    >
                      {p.phoneNormalized}
                    </a>
                  </td>
                  <td><StageBadge prospect={p} /></td>
                  <td className="meta">
                    {p.owner?.name ?? <span className="subtle">Unclaimed</span>}
                  </td>
                  <td className="n meta">{relative(p.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* The sort order carries meaning and is not obvious from one screen of
          rows, so it is stated rather than left to be inferred. */}
      {all.length > 0 && (
        <p className="section-note" style={{ margin: 0 }}>
          Sorted by funnel position: {ORDER.map((s) => LABELS[s]).join(' → ')}.
        </p>
      )}
    </main>
  )
}
