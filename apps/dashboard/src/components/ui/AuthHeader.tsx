import { Moon, Sun } from 'lucide-react'
import { Lockup } from './Lockup'
import { useTheme } from '../../hooks/useTheme'

export function AuthHeader() {
  const { isDark, toggle } = useTheme()
  return (
    <div className="auth-header">
      <div className="auth-lockup"><Lockup markSize={28} wordSize={22} /></div>
      <button className="iconbtn" onClick={toggle} aria-label="Toggle theme">
        {isDark ? <Sun size={19} strokeWidth={2} /> : <Moon size={19} strokeWidth={2} />}
      </button>
    </div>
  )
}
