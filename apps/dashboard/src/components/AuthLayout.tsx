import ThemeToggle from './ThemeToggle'

interface AuthLayoutProps {
  children: React.ReactNode
}

export default function AuthLayout({ children }: AuthLayoutProps) {
  return (
    <div className="auth-page">
      <div className="auth-topbar">
        <a href="/" className="auth-logo">
          <div className="auth-logo-icon">M</div>
          Mesa
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
