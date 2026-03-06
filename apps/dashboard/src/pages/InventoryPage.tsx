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

  async function handleSave(product: typeof rows[number]) {
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
  }

  return (
    <>
      <div className="page-header">
        <span className="section-label">Inventory</span>
        <h1>Stock Overview</h1>
        {isLoading && <p style={{ color: 'var(--smoke)', fontSize: '0.875rem', marginTop: 6 }}>Loading…</p>}
        {(error || saveError) && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem', marginTop: 6 }}>
            {(error as Error | null)?.message ?? saveError}
          </p>
        )}
      </div>

      {/* Mobile: card per product */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {rows.length === 0 && !isLoading && (
          <div className="card" style={{ padding: '1.5rem', color: 'var(--smoke)', textAlign: 'center' }}>
            No products yet.
          </div>
        )}
        {rows.map(product => (
          <div
            key={product.id}
            className="card"
            style={{
              padding: '1rem 1.25rem',
              borderColor: product.isLow ? 'rgba(220, 38, 38, 0.3)' : undefined,
              background: product.isLow ? 'rgba(220, 38, 38, 0.04)' : undefined,
            }}
          >
            <div className="flex-between" style={{ marginBottom: '0.75rem' }}>
              <div>
                <p style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9375rem' }}>{product.name}</p>
                <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>{product.unit}</p>
              </div>
              <div style={{ textAlign: 'right' }}>
                <p style={{ fontWeight: 700, color: 'var(--forest)' }}>₦{Number(product.price).toLocaleString()}</p>
                {product.isLow && (
                  <span className="badge badge-red" style={{ marginTop: 4 }}>Low stock</span>
                )}
              </div>
            </div>

            <div className="flex-between">
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <label style={{ fontSize: '0.8125rem', color: 'var(--smoke)', fontWeight: 500 }}>Stock:</label>
                <input
                  type="number"
                  value={product.stockQuantity}
                  onChange={e => setLocalStock(prev => ({ ...prev, [product.id]: Number(e.target.value) }))}
                  style={{
                    width: 80,
                    padding: '0.35rem 0.5rem',
                    borderRadius: 'var(--radius-sm)',
                    border: `1.5px solid ${product.isLow ? 'rgba(220,38,38,0.4)' : 'var(--ghost)'}`,
                    background: 'var(--cream)',
                    color: product.isLow ? 'var(--danger)' : 'var(--ink)',
                    fontFamily: 'var(--font-body)',
                    fontSize: '0.9rem',
                    outline: 'none',
                  }}
                />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <span style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>Min: {product.lowStockThreshold}</span>
                <button
                  className="btn-ghost"
                  style={{ padding: '0.4rem 0.75rem', fontSize: '0.8125rem' }}
                  onClick={() => handleSave(product)}
                  disabled={saving === product.id}
                >
                  {saving === product.id ? 'Saving…' : 'Save'}
                </button>
              </div>
            </div>
          </div>
        ))}
      </div>
    </>
  )
}
