export default function DashboardPage() {
  return (
    <main style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0b0f1f 0%, #101828 45%, #182230 100%)',
      color: '#e6edf7',
      display: 'grid',
      placeItems: 'center',
      padding: '2rem',
      fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    }}>
      <section style={{
        width: '100%',
        maxWidth: 720,
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 24,
        padding: '2.75rem',
        boxShadow: '0 20px 80px rgba(8, 12, 24, 0.55)',
        textAlign: 'left',
      }}>
        <p style={{ letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 12, color: '#7dd3fc' }}>
          Mesa Dashboard
        </p>
        <h1 style={{ fontSize: 38, margin: '0.75rem 0 0.5rem' }}>Run your WhatsApp business on autopilot</h1>
        <p style={{ color: '#cbd5f5', lineHeight: 1.6, marginBottom: '2rem' }}>
          Your orders, inventory, and revenue — all in one place.
        </p>

        <a
          href="/sign-up"
          style={{
            textDecoration: 'none',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: '0.9rem 1.5rem',
            borderRadius: 999,
            background: 'linear-gradient(120deg, #22c55e, #16a34a)',
            color: '#04110a',
            fontWeight: 700,
            letterSpacing: '0.02em',
          }}
        >
          Sign up
        </a>
      </section>
    </main>
  )
}
