import { useState, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import { TopBar } from '../components/ui/TopBar'
import { Badge } from '../components/ui/Badge'
import { Spark } from '../components/ui/Spark'
import { naira } from '../components/ui/HeroCard'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

type ChartDay = { date: string; revenue: number; orderCount: number }
type SummaryData = {
  revenue?: {
    sevenDays?: { totalRevenue: number; totalOrders: number }
    thirtyDays?: { totalRevenue: number; totalOrders: number }
  }
}
type CustomerData = { stats?: { repeatRate: number } }
type TopProduct = { productName: string; revenue: number }

type Period = 7 | 30 | 90

export default function InsightsPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const [period, setPeriod] = useState<Period>(7)

  const chart = useQuery<{ days: ChartDay[] }>({
    queryKey: ['analytics-chart', merchantId, period],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/revenue-chart?merchantId=${encodeURIComponent(merchantId)}&days=${period}`)
      if (!res.ok) return { days: [] }
      return res.json()
    },
  })

  const summary = useQuery<SummaryData>({
    queryKey: ['analytics-summary', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/summary?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return {}
      return res.json()
    },
  })

  const customers = useQuery<CustomerData>({
    queryKey: ['analytics-customers', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/customers?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return {}
      return res.json()
    },
  })

  const topProducts = useQuery<{ products: TopProduct[] }>({
    queryKey: ['analytics-top-products', merchantId, period],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/top-products?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return { products: [] }
      return res.json()
    },
  })

  const days = chart.data?.days ?? []
  const sparkData = days.map(d => d.revenue)
  const padLen = Math.max(period, sparkData.length)
  const paddedSpark = sparkData.length >= padLen ? sparkData : [...Array(padLen - sparkData.length).fill(0), ...sparkData]
  const displaySpark = paddedSpark.slice(-period)

  // Period totals: use chart data for flexible period
  const { periodTotal, periodOrders } = useMemo(() => {
    const chartTotal = days.reduce((s, d) => s + d.revenue, 0)
    const chartOrders = days.reduce((s, d) => s + d.orderCount, 0)
    if (period === 7) {
      return {
        periodTotal: summary.data?.revenue?.sevenDays?.totalRevenue ?? chartTotal,
        periodOrders: summary.data?.revenue?.sevenDays?.totalOrders ?? chartOrders,
      }
    }
    if (period === 30) {
      return {
        periodTotal: summary.data?.revenue?.thirtyDays?.totalRevenue ?? chartTotal,
        periodOrders: summary.data?.revenue?.thirtyDays?.totalOrders ?? chartOrders,
      }
    }
    // 90d — chart data only (no summary shortcut)
    return { periodTotal: chartTotal, periodOrders: chartOrders }
  }, [period, summary.data, days])

  const thirtyTotal = summary.data?.revenue?.thirtyDays?.totalRevenue ?? 0
  const thirtyOrders = summary.data?.revenue?.thirtyDays?.totalOrders ?? 0
  const avgOrder = periodOrders > 0 ? periodTotal / periodOrders : 0
  const avgOrder30 = thirtyOrders > 0 ? thirtyTotal / thirtyOrders : 0
  const avgDelta = period === 7 ? avgOrder - avgOrder30 : 0
  const repeatRate = customers.data?.stats?.repeatRate ?? 0
  const products = topProducts.data?.products ?? []
  const maxRevenue = Math.max(...products.map(p => p.revenue), 1)


  const periodLabel = period === 7 ? 'Last 7 days' : period === 30 ? 'Last 30 days' : 'Last 90 days'
  const cardTitle = period === 7 ? 'Sales this week' : period === 30 ? 'Sales this month' : 'Sales last 90 days'

  return (
    <div className="pb-tab stagger">
      <TopBar
        title="Insights"
        right={
          <div className="period-sel" style={{ marginRight: 4 }}>
            <button className={period === 7 ? 'on' : ''} onClick={() => setPeriod(7)}>7d</button>
            <button className={period === 30 ? 'on' : ''} onClick={() => setPeriod(30)}>30d</button>
            <button className={period === 90 ? 'on' : ''} onClick={() => setPeriod(90)}>90d</button>
          </div>
        }
      />
      <div className="pad">
        {/* Sales card with sparkline */}
        <div className="card card-lg card-pad fade-up">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="kicker">{cardTitle}</span>
            {periodTotal > 0 && thirtyTotal > 0 && period === 7 && (
              <Badge tone="mint" dot>+{Math.round((periodTotal / Math.max(thirtyTotal / 4, 1)) * 100 - 100)}%</Badge>
            )}
          </div>
          <div className="naira" style={{ fontSize: 34, marginTop: 10 }}>{naira(periodTotal)}</div>
          <div style={{ color: 'var(--muted)', fontSize: 12.5, marginTop: 4, fontFamily: 'var(--fm)' }}>
            {periodOrders} order{periodOrders !== 1 ? 's' : ''}
          </div>
          {displaySpark.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <Spark data={displaySpark} />
            </div>
          )}
        </div>

        {/* Avg order + Repeat buyers */}
        <div className="grid2" style={{ marginTop: 14 }}>
          <div className="card card-pad fade-up">
            <div className="kicker">Avg order</div>
            <div className="naira" style={{ fontSize: 24, marginTop: 8 }}>{naira(avgOrder)}</div>
            {period === 7 && avgDelta !== 0 && (
              <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>
                {avgDelta > 0 ? '+' : ''}{naira(avgDelta)} vs 30d avg
              </div>
            )}
          </div>
          <div className="card card-pad fade-up">
            <div className="kicker">Repeat buyers</div>
            <div className="naira" style={{ fontSize: 24, marginTop: 8 }}>{repeatRate}%</div>
            <div className="muted" style={{ fontSize: 12, marginTop: 2 }}>of all customers</div>
          </div>
        </div>


        {/* Top products */}
        {products.length > 0 && (
          <>
            <div className="sec-head"><span className="st">Top products</span></div>
            <div className="card card-pad fade-up" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
              {products.slice(0, 5).map(p => (
                <div key={p.productName}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 7 }}>
                    <span style={{ fontWeight: 600, fontSize: 14 }}>{p.productName}</span>
                    <span className="mono muted" style={{ fontSize: 12.5 }}>{naira(p.revenue)}</span>
                  </div>
                  <div className="meter">
                    <div className="fill" style={{ width: `${(p.revenue / maxRevenue) * 100}%` }} />
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
