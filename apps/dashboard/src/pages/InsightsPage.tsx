import { useQuery } from '@tanstack/react-query'
import { TopBar } from '../components/ui/TopBar'
import { Badge } from '../components/ui/Badge'
import { Spark } from '../components/ui/Spark'
import { naira } from '../components/ui/HeroCard'
import { apiFetch } from '../lib/api'
import { getSession } from '../lib/auth'

type ChartDay = { date: string; revenue: number; orderCount: number }
type SummaryData = {
  revenue?: { sevenDays?: { totalRevenue: number; totalOrders: number }; thirtyDays?: { totalRevenue: number; totalOrders: number } }
}
type CustomerData = { stats?: { repeatRate: number } }
type TopProduct = { productName: string; revenue: number }

export default function InsightsPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''

  const chart = useQuery<{ days: ChartDay[] }>({
    queryKey: ['analytics-chart', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/revenue-chart?merchantId=${encodeURIComponent(merchantId)}&days=7`)
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
    queryKey: ['analytics-top-products', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/analytics/top-products?merchantId=${encodeURIComponent(merchantId)}`)
      if (!res.ok) return { products: [] }
      return res.json()
    },
  })

  const days = chart.data?.days ?? []
  const sparkData = days.map(d => d.revenue)
  const weekTotal = summary.data?.revenue?.sevenDays?.totalRevenue ?? 0
  const weekOrders = summary.data?.revenue?.sevenDays?.totalOrders ?? 0
  const thirtyTotal = summary.data?.revenue?.thirtyDays?.totalRevenue ?? 0
  const thirtyOrders = summary.data?.revenue?.thirtyDays?.totalOrders ?? 0
  const avgOrder = weekOrders > 0 ? weekTotal / weekOrders : 0
  const avgOrder30 = thirtyOrders > 0 ? thirtyTotal / thirtyOrders : 0
  const avgDelta = avgOrder - avgOrder30
  const repeatRate = customers.data?.stats?.repeatRate ?? 0
  const products = topProducts.data?.products ?? []
  const maxRevenue = Math.max(...products.map(p => p.revenue), 1)

  return (
    <div className="pb-tab stagger">
      <TopBar title="Insights" sub="Last 7 days" />
      <div className="pad">
        {/* Sales card with sparkline */}
        <div className="card card-lg card-pad fade-up">
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="kicker">Sales this week</span>
            {weekTotal > 0 && <Badge tone="mint" dot>+{Math.round((weekTotal / Math.max(thirtyTotal / 4, 1)) * 100 - 100)}%</Badge>}
          </div>
          <div className="naira" style={{ fontSize: 34, marginTop: 10 }}>{naira(weekTotal)}</div>
          {sparkData.length > 0 && (
            <div style={{ marginTop: 18 }}>
              <Spark data={sparkData.length === 7 ? sparkData : [...Array(7 - sparkData.length).fill(0), ...sparkData]} />
            </div>
          )}
        </div>

        {/* Avg order + Repeat buyers */}
        <div className="grid2" style={{ marginTop: 14 }}>
          <div className="card card-pad fade-up">
            <div className="kicker">Avg order</div>
            <div className="naira" style={{ fontSize: 24, marginTop: 8 }}>{naira(avgOrder)}</div>
            {avgDelta !== 0 && (
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
