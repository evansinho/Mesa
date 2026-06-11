type Props = { markSize?: number; wordSize?: number; light?: boolean }

export function Lockup({ markSize = 34, wordSize = 28, light }: Props) {
  const wordColor = light ? '#fff' : 'var(--ink)'
  const tileColor = light ? 'rgba(255,255,255,.15)' : 'var(--forest)'
  const plateauColor = light ? 'rgba(255,255,255,.55)' : 'var(--paper)'
  const dotColor = 'var(--mint)'

  return (
    <div className="lock" style={{ gap: markSize * 0.32 }}>
      <svg width={markSize} height={markSize} viewBox="0 0 32 32" fill="none">
        <rect width="32" height="32" rx="7" fill={tileColor} />
        <polygon points="10,10 22,10 28,23 4,23" fill={plateauColor} />
        <circle cx="23" cy="8" r="3.5" fill={dotColor} />
      </svg>
      <span className="word" style={{ fontSize: wordSize, color: wordColor }}>Mesa</span>
    </div>
  )
}
