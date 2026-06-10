import ThemeToggle from './ThemeToggle'

interface AuthLayoutProps {
  children: React.ReactNode
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="auth-page">
      <div className="auth-topbar">
        <a href="/" className="auth-logo">
          <img src="/mark-tile.svg" width="28" height="28" alt="" />
          <span style={{ fontFamily: "'Newsreader', Georgia, serif", fontWeight: 600 }}>Mesa</span>
        </a>
        <ThemeToggle />
      </div>
      <div className="auth-body">
        <div className="auth-card">
          {children}
        </div>
      </div>
    </div>
  )
}
