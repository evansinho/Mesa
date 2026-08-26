import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Link } from '@tanstack/react-router'
import { AlertTriangle, Lock, Columns3 } from 'lucide-react'
import { api, type ProspectStage } from '../lib/api'
import { useProspects } from '../lib/prospects'
import { naira } from '../components/charts'
import MerchantDrawer from '../components/MerchantDrawer'
import {
  fetchMerchants, initials, STAGES, STAGE_COLOR, STAGE_LABELS, type Merchant,
} from '../lib/merchants'

// Only the prospect column is a drop target.
//
// The four columns to its right are derived from what merchants actually do in
// the product, so dragging a card into "Paying" would be asserting something
// only a payment can make true. The board still shows all five, because seeing
// the whole funnel is the point — the derived ones just refuse the drop and say
// why.
const DRAGGABLE_STAGE = 'prospect'

// Within the prospect column, the human-owned sub-stages a card can be dragged
// between.
const PROSPECT_STAGES: ProspectStage[] = ['SOURCED', 'CONTACTED', 'DEMOED']

type Card = {
  key: string
  name: string
  meta: string
  mrr: number
  risk: string | null
  owner: string | null
  prospectId?: string
  merchantId?: string
  stage: ProspectStage | null
}

export default function PipelinePage() {
  const qc = useQueryClient()
  const [openId, setOpenId] = useState<string | null>(null)
  const [dragKey, setDragKey] = useState<string | null>(null)
  const [overCol, setOverCol] = useState<string | null>(null)
  const [refused, setRefused] = useState<string | null>(null)

  const prospects = useProspects()
  const merchants = useQuery({ queryKey: ['merchants', ''], queryFn: () => fetchMerchants() })

  const move = useMutation({
    mutationFn: ({ id, stage }: { id: string; stage: ProspectStage }) =>
      api.patch(`/staff/prospects/${id}`, { stage }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['prospects'] })
      qc.invalidateQueries({ queryKey: ['dashboard'] })
    },
  })

  const preSignup = (prospects.data?.data ?? []).filter((p) => !p.merchantId)
  const byStage: Record<string, Card[]> = {
    prospect: preSignup
      .filter((p) => PROSPECT_STAGES.includes(p.stage as ProspectStage))
      .map((p) => ({
        key: p.id,
        name: p.businessName,
        meta: `${p.source}${p.sourceDetail ? ` · ${p.sourceDetail}` : ''}`,
        mrr: 0,
        risk: null,
        owner: p.owner?.name ?? null,
        prospectId: p.id,
        stage: p.stage as ProspectStage,
      })),
    onboarding: [], activated: [], paying: [], churned: [],
  }

  for (const m of merchants.data ?? []) {
    byStage[m.displayStage]?.push({
      key: m.id,
      name: m.name,
      meta: `${m.source ?? '—'}${m.sourceDetail ? ` · ${m.sourceDetail}` : ''}`,
      mrr: m.mrr,
      risk: m.risk,
      owner: m.owner?.name ?? null,
      merchantId: m.id,
      stage: null,
    })
  }

  return (
    <main className="page">
      <div className="hint-row">
        <Columns3 size={15} />
        Drag a prospect card to change its stage. Everything after signup is
        worked out from the product and cannot be dragged.
      </div>

      {refused && (
        <div className="notice-error" role="status">
          <Lock size={13} style={{ verticalAlign: -2, marginRight: 6 }} />
          {refused}
        </div>
      )}

      <div className="board">
        {STAGES.map((stage) => {
          const cards = byStage[stage] ?? []
          const mrr = cards.reduce((t, c) => t + c.mrr, 0)
          const derived = stage !== DRAGGABLE_STAGE

          return (
            <div
              key={stage}
              className={`col ${overCol === stage ? 'is-over' : ''} ${derived ? 'is-derived' : ''}`}
              onDragOver={(e) => {
                if (derived || !dragKey) return
                e.preventDefault()
                setOverCol(stage)
              }}
              onDragLeave={() => setOverCol((c) => (c === stage ? null : c))}
              onDrop={() => {
                setOverCol(null)
                if (derived) {
                  setRefused(
                    `${STAGE_LABELS[stage]} is worked out from what the merchant does in Mesa. ` +
                      'Nobody can set it by hand.',
                  )
                  setTimeout(() => setRefused(null), 5000)
                }
                setDragKey(null)
              }}
            >
              <div className="col-h">
                <i className="col-dot" style={{ background: STAGE_COLOR[stage] }} />
                <span className="col-t">{STAGE_LABELS[stage]}</span>
                {derived && <Lock size={11} className="col-lock" />}
                <span className="col-n">{cards.length}</span>
              </div>
              {mrr > 0 && <div className="col-mrr">{naira(mrr)} MRR</div>}

              {cards.length === 0 ? (
                <div className="col-empty">{derived ? 'Nothing here' : 'Drop here'}</div>
              ) : (
                cards.map((c) => (
                  <div
                    key={c.key}
                    className={`pcard ${dragKey === c.key ? 'is-dragging' : ''}`}
                    draggable={!derived}
                    onDragStart={() => setDragKey(c.key)}
                    onDragEnd={() => { setDragKey(null); setOverCol(null) }}
                    tabIndex={0}
                    role="button"
                    onClick={() => c.merchantId && setOpenId(c.merchantId)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && c.merchantId) {
                        e.preventDefault()
                        setOpenId(c.merchantId)
                      }
                    }}
                  >
                    {c.prospectId ? (
                      <Link to="/prospects/$id" params={{ id: c.prospectId }} className="pcard-name">
                        {c.name}
                      </Link>
                    ) : (
                      <span className="pcard-name">{c.name}</span>
                    )}
                    <span className="lb-sub truncate">{c.meta}</span>
                    {c.risk && (
                      <span className="pcard-risk">
                        <AlertTriangle size={12} />
                        {c.risk}
                      </span>
                    )}
                    <div className="pcard-foot">
                      <span className={c.mrr > 0 ? 'pcard-mrr' : 'pcard-mrr pcard-mrr--zero'}>
                        {c.mrr > 0 ? naira(c.mrr) : '—'}
                      </span>
                      {c.owner && <span className="pcard-rep">{initials(c.owner)}</span>}
                    </div>

                    {/* Keyboard equivalent for the drag, and the only way to
                        move a card on a touch screen. */}
                    {!derived && c.prospectId && (
                      <div className="pcard-move">
                        {PROSPECT_STAGES.map((s) => (
                          <button
                            key={s}
                            data-on={c.stage === s}
                            disabled={move.isPending}
                            onClick={(e) => {
                              e.stopPropagation()
                              if (c.stage !== s) move.mutate({ id: c.prospectId!, stage: s })
                            }}
                          >
                            {s.charAt(0) + s.slice(1).toLowerCase()}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                ))
              )}
            </div>
          )
        })}
      </div>

      <MerchantDrawer merchantId={openId} onClose={() => setOpenId(null)} />
    </main>
  )
}
