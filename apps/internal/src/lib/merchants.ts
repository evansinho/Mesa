import { api, type Wrapped } from './api'

/**
 * The five display stages from the design handoff.
 *
 * These are a coarser view of the eight derived lifecycle states, mapped
 * server-side so the client never re-derives the funnel. AT_RISK is
 * deliberately absent: risk is a flag on a card, not a column, so an at-risk
 * merchant still shows wherever they actually sit.
 */
export const STAGES = ['prospect', 'onboarding', 'activated', 'paying', 'churned'] as const
export type DisplayStage = (typeof STAGES)[number]

export const STAGE_LABELS: Record<string, string> = {
  prospect: 'Prospect',
  onboarding: 'Onboarding',
  activated: 'Activated',
  paying: 'Paying',
  churned: 'Churned',
}

export const STAGE_TONE: Record<string, string> = {
  prospect: 'neutral',
  onboarding: 'warning',
  activated: 'info',
  paying: 'success',
  churned: 'danger',
}

export const STAGE_COLOR: Record<string, string> = {
  prospect: 'var(--stage-prospect)',
  onboarding: 'var(--stage-onboarding)',
  activated: 'var(--stage-activated)',
  paying: 'var(--stage-paying)',
  churned: 'var(--stage-churned)',
}

export type Merchant = {
  id: string
  name: string
  phone: string
  displayStage: string
  lifecycleState: string | null
  tier: string
  subscriptionStatus: string
  isTestAccount: boolean
  mrr: number
  orders30d: number
  activationDays: number | null
  connectedAt: string | null
  lastActivityAt: string | null
  owner: { id: string; name: string } | null
  prospectId: string | null
  source: string | null
  sourceDetail: string | null
  risk: string | null
  createdAt: string
}

export function fetchMerchants(q?: string) {
  const qs = q ? `?q=${encodeURIComponent(q)}` : ''
  return api.get<Wrapped<Merchant[]>>(`/staff/merchants${qs}`).then((r) => r.data)
}

export function initials(name: string): string {
  return name.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('')
}

export function relative(iso: string | null): string {
  if (!iso) return '—'
  const ms = Date.now() - new Date(iso).getTime()
  const days = Math.floor(ms / 86_400_000)
  if (days <= 0) {
    const hours = Math.floor(ms / 3_600_000)
    return hours <= 0 ? 'just now' : `${hours}h ago`
  }
  if (days === 1) return 'yesterday'
  if (days < 30) return `${days}d ago`
  return `${Math.floor(days / 30)}mo ago`
}
