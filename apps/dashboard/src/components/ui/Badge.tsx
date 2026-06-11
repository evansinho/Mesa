type Tone = 'mint' | 'amber' | 'ink' | 'danger' | 'subtle'

type Props = {
  tone?: Tone
  dot?: boolean
  children: React.ReactNode
}

export function Badge({ tone = 'ink', dot, children }: Props) {
  return (
    <span className={`badge badge-${tone}`}>
      {dot && <span className="bd" />}
      {children}
    </span>
  )
}
