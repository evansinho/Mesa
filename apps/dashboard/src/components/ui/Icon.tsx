import * as LucideIcons from 'lucide-react'

type Props = {
  name: string
  size?: number
  strokeWidth?: number
  color?: string
  className?: string
  style?: React.CSSProperties
}

export function Icon({ name, size = 20, strokeWidth = 2, color, className, style }: Props) {
  const pascal = name.replace(/(^|-)([a-z])/g, (_, __, c) => c.toUpperCase())
  const Comp = (LucideIcons as unknown as Record<string, React.ComponentType<LucideIcons.LucideProps>>)[pascal]
  if (!Comp) return null
  return <Comp size={size} strokeWidth={strokeWidth} color={color} className={className} style={style} />
}
