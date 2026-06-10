type Props = { markSize?: number; wordSize?: number; light?: boolean }

export function Lockup({ markSize = 34, wordSize = 28, light }: Props) {
  const wordColor = light ? '#fff' : 'var(--ink)'
  const tileColor = light ? 'rgba(255,255,255,.15)' : 'var(--forest)'
  const plateauColor = light ? 'rgba(255,255,255,.55)' : 'var(--paper)'
  const dotColor = 'var(--mint)'

  return (
    <div className="lock" style={{ gap: markSize * 0.32 }}>
      <svg width={markSize} height={markSize} viewBox="0 0 40 40" fill="none">
        <rect width="40" height="40" rx="10" fill={tileColor} />
        <rect x="8" y="20" width="24" height="12" rx="4" fill={plateauColor} />
        <circle cx="20" cy="32" r="4" fill={dotColor} />
      </svg>
      <span className="word" style={{ fontSize: wordSize, color: wordColor }}>Mesa</span>
    </div>
  )
}
