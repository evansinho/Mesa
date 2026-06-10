type Props = { data: number[]; peakIdx?: number }

export function Spark({ data, peakIdx }: Props) {
  const max = Math.max(...data, 1)
  const days = ['M', 'T', 'W', 'T', 'F', 'S', 'S']
  const peak = peakIdx ?? data.indexOf(Math.max(...data))
  return (
    <div>
      <div className="spark">
        {data.map((v, i) => (
          <div key={i} className={`b${i === peak ? ' peak' : ''}`} style={{ height: `${(v / max) * 100}%` }} />
        ))}
      </div>
      <div style={{ display: 'flex', marginTop: 8 }}>
        {days.slice(0, data.length).map((d, i) => (
          <span key={i} className="mono subtle" style={{ flex: 1, textAlign: 'center', fontSize: 11 }}>{d}</span>
        ))}
      </div>
    </div>
  )
}
