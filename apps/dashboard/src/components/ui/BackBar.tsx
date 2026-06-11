import { ChevronLeft } from 'lucide-react'

type Props = {
  onBack: () => void
  title?: string
  right?: React.ReactNode
  dark?: boolean
}

export function BackBar({ onBack, title, right, dark }: Props) {
  return (
    <div className={`backbar${dark ? ' on-dark' : ''}`} style={{ justifyContent: 'space-between' }}>
      <button className="backbtn" onClick={onBack}>
        <ChevronLeft size={22} strokeWidth={2.2} />
        {title && <span>{title}</span>}
      </button>
      {right}
    </div>
  )
}
