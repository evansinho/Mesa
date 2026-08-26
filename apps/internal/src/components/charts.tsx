/**
 * Chart primitives, ported from the design handoff's parts.jsx.
 *
 * Hand-rolled inline SVG rather than a charting dependency, exactly as the
 * prototype specifies: two charts do not justify a library, and the handoff's
 * geometry is precise enough to reproduce directly.
 *
 * Accent green appears here as the actual-series line and its area wash. That
 * is one of the view's allowed stamps — the plan line stays neutral ink so the
 * eye goes to what happened, not to the target.
 */

const ACCENT = 'var(--accent-500)'

export function TrendChart({
  months,
  actual,
  plan,
  height = 208,
}: {
  months: string[]
  actual: number[]
  plan: number[]
  height?: number
}) {
  if (months.length < 2) return null

  const w = 620
  const padL = 34
  const padR = 12
  const padT = 14
  const padB = 26

  // Headroom above the tallest series so the last marker never clips the top.
  const max = Math.max(...actual, ...plan, 1) * 1.18
  const iw = w - padL - padR
  const ih = height - padT - padB

  const x = (i: number) => padL + (iw * i) / (months.length - 1)
  const y = (v: number) => padT + ih - (ih * v) / max

  const line = (arr: number[]) =>
    arr.map((v, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')

  const area =
    `${line(actual)} L${x(actual.length - 1).toFixed(1)},${(padT + ih).toFixed(1)} ` +
    `L${padL},${(padT + ih).toFixed(1)} Z`

  const ticks = [0, Math.round(max / 2), Math.round(max)]

  return (
    <svg
      viewBox={`0 0 ${w} ${height}`}
      style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
      role="img"
      aria-label="Merchants on Mesa against plan"
    >
      {/* Solid hairlines one step off the surface. Dashed gridlines read as a
          threshold when they are only a grid. */}
      {ticks.map((t, i) => (
        <g key={i}>
          <line x1={padL} y1={y(t)} x2={w - padR} y2={y(t)} stroke="rgba(11,31,23,.09)" strokeWidth="1" />
          <text
            x={padL - 9}
            y={y(t) + 4}
            textAnchor="end"
            fontFamily="Geist Mono, monospace"
            fontSize="10"
            fill="var(--text-subtle)"
          >
            {t}
          </text>
        </g>
      ))}

      <defs>
        <linearGradient id="mesaFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#1fb36b" stopOpacity="0.24" />
          <stop offset="100%" stopColor="#1fb36b" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      <path d={area} fill="url(#mesaFill)" />

      {/* Plan is dashed neutral ink, deliberately recessive. */}
      <path d={line(plan)} fill="none" stroke="rgba(11,31,23,.28)" strokeWidth="1.8" strokeDasharray="5 4" />
      <path d={line(actual)} fill="none" stroke={ACCENT} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />

      {/* Markers carry a surface-coloured fill so they stay legible where they
          cross the line; the last one is filled to mark "now". */}
      {actual.map((v, i) => (
        <circle
          key={i}
          cx={x(i)}
          cy={y(v)}
          r={i === actual.length - 1 ? 5 : 3}
          fill={i === actual.length - 1 ? '#1fb36b' : '#fff'}
          stroke={ACCENT}
          strokeWidth="2"
        />
      ))}

      {months.map((m, i) => (
        <text
          key={`${m}-${i}`}
          x={x(i)}
          y={height - 6}
          textAnchor="middle"
          fontFamily="Geist Mono, monospace"
          fontSize="10"
          fill={i === months.length - 1 ? 'var(--ink)' : 'var(--text-subtle)'}
          fontWeight={i === months.length - 1 ? 600 : 400}
        >
          {m}
        </text>
      ))}
    </svg>
  )
}

export function Spark({ data, w = 56, h = 22 }: { data: number[]; w?: number; h?: number }) {
  if (data.length < 2) return <svg width={w} height={h} aria-hidden="true" />
  const max = Math.max(...data, 1)
  const pts = data
    .map((v, i) => `${(w * i) / (data.length - 1)},${h - (h - 3) * (v / max) - 1.5}`)
    .join(' ')
  return (
    <svg width={w} height={h} style={{ display: 'block', overflow: 'visible' }} aria-hidden="true">
      <polyline
        points={pts}
        fill="none"
        stroke={ACCENT}
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

/** ₦ compact, per the brand rule that naira figures are always numerals. */
export function naira(v: number): string {
  if (v >= 1_000_000) return `₦${(v / 1_000_000).toFixed(v >= 10_000_000 ? 0 : 1)}M`
  if (v >= 1_000) return `₦${Math.round(v / 1_000)}k`
  return `₦${v}`
}
