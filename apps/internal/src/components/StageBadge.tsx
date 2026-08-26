import type { Prospect } from '../lib/api'

// Stage tones come from the handoff's five-stage mapping: prospect → neutral,
// onboarding → warning, activated → info, paying → success, churned → danger.
const TONES: Record<string, string> = {
  SOURCED: 'neutral',
  CONTACTED: 'warning',
  DEMOED: 'info',
  DORMANT: 'neutral',
  DISQUALIFIED: 'danger',
}

/**
 * One badge carrying two different things, which is the point of the model:
 * before signup it shows the human-owned sales stage; after signup it shows
 * that Mesa has taken over. A rep can move the former and never the latter.
 */
export default function StageBadge({ prospect }: { prospect: Prospect }) {
  if (prospect.merchantId) {
    return (
      <span className="badge badge--success">
        <span className="badge__dot" />
        On Mesa
      </span>
    )
  }

  const tone = TONES[prospect.stage] ?? 'neutral'
  const label = prospect.stage.charAt(0) + prospect.stage.slice(1).toLowerCase()

  return (
    <span className={`badge badge--${tone}`}>
      <span className="badge__dot" />
      {label}
    </span>
  )
}
