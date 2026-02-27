import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'

type Product = {
  id: string
  name: string
  price: string
  stockQuantity: number
  lowStockThreshold: number
  unit: string
}

export default function InventoryPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const queryClient = useQueryClient()
  const [localStock, setLocalStock] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const { data, isLoading, error } = useQuery<Product[]>({
    queryKey: ['products', merchantId],
    enabled: !!merchantId,
    queryFn: async () => {
      const res = await apiFetch(`/merchants/${encodeURIComponent(merchantId)}/products`)
      if (!res.ok) throw new Error(await res.text())
      const json = await res.json() as { products?: Product[] }
      return json.products ?? []
    },
  })

  const rows = useMemo(() => (data ?? []).map(product => ({
    ...product,
    stockQuantity: localStock[product.id] ?? product.stockQuantity,
    isLow: (localStock[product.id] ?? product.stockQuantity) <= product.lowStockThreshold,
  })), [data, localStock])

  return (
    <main style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #0b0f1f 0%, #101828 45%, #182230 100%)',
      color: '#e6edf7',
      padding: '2.5rem',
      fontFamily: '"Space Grotesk", "Segoe UI", sans-serif',
    }}>
      <header style={{ marginBottom: '2rem' }}>
        <p style={{ letterSpacing: '0.18em', textTransform: 'uppercase', fontSize: 12, color: '#7dd3fc' }}>
          Inventory
        </p>
        <h1 style={{ fontSize: 36, margin: '0.5rem 0 1rem' }}>Stock Overview</h1>
        <div style={{ display: 'flex', gap: '1rem', alignItems: 'center', flexWrap: 'wrap' }}>
          {isLoading && <span style={{ color: '#94a3b8' }}>Loading…</span>}
          {error && <span style={{ color: '#fca5a5' }}>{(error as Error).message}</span>}
          {saveError && <span style={{ color: '#fca5a5' }}>{saveError}</span>}
        </div>
      </header>

      <section style={{
        background: 'rgba(14, 22, 40, 0.88)',
        border: '1px solid rgba(148, 163, 184, 0.18)',
        borderRadius: 18,
        overflow: 'hidden',
      }}>
        <div style={{
          display: 'grid',
          gridTemplateColumns: '2fr 1fr 1fr 1fr',
          gap: '1rem',
          padding: '1rem 1.5rem',
          fontSize: 13,
          textTransform: 'uppercase',
          letterSpacing: '0.12em',
          color: '#94a3b8',
          borderBottom: '1px solid rgba(148, 163, 184, 0.1)',
        }}>
          <div>Product</div>
          <div>Price</div>
          <div>Stock</div>
          <div>Threshold</div>
        </div>

        {rows.length === 0 && !isLoading && (
          <div style={{ padding: '1.5rem', color: '#94a3b8' }}>
            No products yet.
          </div>
        )}

        {rows.map(product => (
          <div
            key={product.id}
            style={{
              display: 'grid',
              gridTemplateColumns: '2fr 1fr 1fr 1fr',
              gap: '1rem',
              padding: '1rem 1.5rem',
              borderBottom: '1px solid rgba(148, 163, 184, 0.06)',
              alignItems: 'center',
              background: product.isLow ? 'rgba(248, 113, 113, 0.08)' : 'transparent',
            }}
          >
            <div style={{ display: 'grid' }}>
              <span style={{ fontWeight: 600 }}>{product.name}</span>
              <span style={{ color: '#94a3b8', fontSize: 12 }}>{product.unit}</span>
            </div>
            <div>₦{Number(product.price).toLocaleString()}</div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <input
                type="number"
                value={product.stockQuantity}
                onChange={(e) => {
                  setLocalStock(prev => ({ ...prev, [product.id]: Number(e.target.value) }))
                }}
                style={{
                  width: 80,
                  padding: '0.4rem 0.5rem',
                  borderRadius: 8,
                  border: '1px solid rgba(148, 163, 184, 0.3)',
                  background: '#0b1220',
                  color: product.isLow ? '#fca5a5' : '#e2e8f0',
                }}
              />
              <button
                onClick={async () => {
                  setSaving(product.id)
                  setSaveError(null)
                  const res = await apiFetch(`/merchants/${merchantId}/products/${product.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ stockQuantity: product.stockQuantity }),
                  })
                  if (!res.ok) {
                    const text = await res.text()
                    setSaveError(text || 'Failed to update stock')
                  } else {
                    await queryClient.invalidateQueries({ queryKey: ['products', merchantId] })
                    setLocalStock(prev => {
                      const next = { ...prev }
                      delete next[product.id]
                      return next
                    })
                  }
                  setSaving(null)
                }}
                style={{
                  padding: '0.35rem 0.6rem',
                  borderRadius: 8,
                  border: '1px solid rgba(148, 163, 184, 0.3)',
                  background: 'transparent',
                  color: '#e2e8f0',
                  cursor: 'pointer',
                }}
                disabled={saving === product.id}
              >
                {saving === product.id ? 'Saving…' : 'Save'}
              </button>
            </div>
            <div style={{ color: '#94a3b8' }}>{product.lowStockThreshold}</div>
          </div>
        ))}
      </section>
    </main>
  )
}
