import type { Prospect } from '../lib/api'

/**
 * One badge for two different things, which is the whole point of the design:
 * before signup it shows the human-owned sales stage, and after signup it
 * shows that Mesa has taken over. A rep can move the former and never the
 * latter.
 */
export default function StageBadge({ prospect }: { prospect: Prospect }) {
  if (prospect.merchantId) {
    return <span className="badge live">On Mesa</span>
  }
  return (
    <span className={`badge ${prospect.stage.toLowerCase()}`}>
      {prospect.stage.charAt(0) + prospect.stage.slice(1).toLowerCase()}
    </span>
  )
}
