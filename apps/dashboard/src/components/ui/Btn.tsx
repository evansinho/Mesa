import { Icon } from './Icon'

type Props = {
  kind?: 'primary' | 'mint' | 'ghost' | 'quiet'
  size?: 'sm' | 'md' | 'lg'
  block?: boolean
  icon?: string
  iconRight?: string
  disabled?: boolean
  loading?: boolean
  onClick?: () => void
  children: React.ReactNode
  type?: 'button' | 'submit'
  style?: React.CSSProperties
}

export function Btn({ kind = 'primary', size = 'lg', block, icon, iconRight, disabled, loading, onClick, children, type = 'button', style }: Props) {
  const cls = [
    'btn',
    `btn-${kind}`,
    `btn-${size}`,
    block ? 'btn-block' : '',
  ].filter(Boolean).join(' ')

  const iconSize = size === 'sm' ? 15 : size === 'md' ? 17 : 18

  return (
    <button className={cls} disabled={disabled || loading} onClick={onClick} type={type} style={style}>
      {loading ? <span className="spin"><Icon name="loader-circle" size={iconSize} strokeWidth={2} /></span>
        : icon ? <Icon name={icon} size={iconSize} strokeWidth={2} /> : null}
      {children}
      {!loading && iconRight && <Icon name={iconRight} size={iconSize} strokeWidth={2} />}
    </button>
  )
}
