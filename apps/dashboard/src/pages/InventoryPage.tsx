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

type EditFields = {
  name: string
  price: string
  unit: string
  lowStockThreshold: string
}

type AddForm = {
  name: string
  price: string
  unit: string
  stockQuantity: string
  lowStockThreshold: string
}

const emptyAdd: AddForm = { name: '', price: '', unit: 'unit', stockQuantity: '0', lowStockThreshold: '5' }

export default function InventoryPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const queryClient = useQueryClient()

  const [localStock, setLocalStock] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  // Edit product fields
  const [editing, setEditing] = useState<string | null>(null)
  const [editFields, setEditFields] = useState<EditFields>({ name: '', price: '', unit: '', lowStockThreshold: '' })
  const [editSaving, setEditSaving] = useState(false)

  // Add product
  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState<AddForm>(emptyAdd)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  // Delete
  const [deleting, setDeleting] = useState<string | null>(null)

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

  async function handleSaveStock(product: typeof rows[number]) {
    setSaving(product.id)
    setSaveError(null)
    const res = await apiFetch(`/merchants/${merchantId}/products/${product.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ stockQuantity: product.stockQuantity }),
    })
    if (!res.ok) {
      setSaveError('Failed to update stock')
    } else {
      await queryClient.invalidateQueries({ queryKey: ['products', merchantId] })
      setLocalStock(prev => { const n = { ...prev }; delete n[product.id]; return n })
    }
    setSaving(null)
  }

  function startEdit(product: Product) {
    setEditing(product.id)
    setEditFields({
      name: product.name,
      price: Number(product.price).toString(),
      unit: product.unit,
      lowStockThreshold: product.lowStockThreshold.toString(),
    })
  }

  async function handleSaveEdit(productId: string) {
    setEditSaving(true)
    const res = await apiFetch(`/merchants/${merchantId}/products/${productId}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editFields.name,
        price: parseFloat(editFields.price),
        unit: editFields.unit,
        lowStockThreshold: parseInt(editFields.lowStockThreshold, 10),
      }),
    })
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['products', merchantId] })
      setEditing(null)
    } else {
      setSaveError('Failed to update product')
    }
    setEditSaving(false)
  }

  async function handleDelete(productId: string) {
    if (!confirm('Delete this product? This cannot be undone.')) return
    setDeleting(productId)
    const res = await apiFetch(`/merchants/${merchantId}/products/${productId}`, { method: 'DELETE' })
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['products', merchantId] })
    } else {
      setSaveError('Failed to delete product')
    }
    setDeleting(null)
  }

  async function handleAdd() {
    setAddError(null)
    if (!addForm.name.trim()) { setAddError('Name is required'); return }
    if (!addForm.price || isNaN(parseFloat(addForm.price))) { setAddError('Valid price is required'); return }
    setAddSaving(true)
    const res = await apiFetch(`/merchants/${merchantId}/products`, {
      method: 'POST',
      body: JSON.stringify({
        name: addForm.name.trim(),
        price: parseFloat(addForm.price),
        unit: addForm.unit.trim() || 'unit',
        stockQuantity: parseInt(addForm.stockQuantity, 10) || 0,
        lowStockThreshold: parseInt(addForm.lowStockThreshold, 10) || 5,
      }),
    })
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['products', merchantId] })
      setShowAdd(false)
      setAddForm(emptyAdd)
    } else {
      setAddError('Failed to add product')
    }
    setAddSaving(false)
  }

  return (
    <>
      <div className="page-header" style={{ marginBottom: '1.25rem' }}>
        <div className="flex-between">
          <div>
            <span className="section-label">Inventory</span>
            <h1>Stock Overview</h1>
          </div>
          <button
            className="btn-primary"
            style={{ padding: '0.55rem 1.1rem', fontSize: '0.875rem' }}
            onClick={() => { setShowAdd(true); setAddError(null); setAddForm(emptyAdd) }}
          >
            + Add product
          </button>
        </div>
        {isLoading && <p style={{ color: 'var(--smoke)', fontSize: '0.875rem', marginTop: 6 }}>Loading…</p>}
        {(error || saveError) && (
          <p style={{ color: 'var(--danger)', fontSize: '0.875rem', marginTop: 6 }}>
            {(error as Error | null)?.message ?? saveError}
          </p>
        )}
      </div>

      {/* Add product form */}
      {showAdd && (
        <div className="card" style={{ padding: '1.25rem', marginBottom: '1rem', border: '1.5px solid var(--forest)' }}>
          <p style={{ fontWeight: 600, marginBottom: '1rem', color: 'var(--ink)' }}>New product</p>
          {addError && <p style={{ color: 'var(--danger)', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>{addError}</p>}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
            <label style={labelStyle}>
              Name
              <input style={inputStyle} value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Basmati Rice" />
            </label>
            <label style={labelStyle}>
              Unit price (₦)
              <input style={inputStyle} type="number" value={addForm.price} onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))} placeholder="0" />
            </label>
            <label style={labelStyle}>
              Unit
              <input style={inputStyle} value={addForm.unit} onChange={e => setAddForm(f => ({ ...f, unit: e.target.value }))} placeholder="bag, bottle, kg…" />
            </label>
            <label style={labelStyle}>
              Opening stock
              <input style={inputStyle} type="number" value={addForm.stockQuantity} onChange={e => setAddForm(f => ({ ...f, stockQuantity: e.target.value }))} />
            </label>
            <label style={labelStyle}>
              Low-stock alert at
              <input style={inputStyle} type="number" value={addForm.lowStockThreshold} onChange={e => setAddForm(f => ({ ...f, lowStockThreshold: e.target.value }))} />
            </label>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
            <button className="btn-ghost" style={smallBtnStyle} onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn-primary" style={smallBtnStyle} onClick={handleAdd} disabled={addSaving}>
              {addSaving ? 'Adding…' : 'Add product'}
            </button>
          </div>
        </div>
      )}

      {/* Product cards */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {rows.length === 0 && !isLoading && !showAdd && (
          <div className="card" style={{ padding: '1.5rem', color: 'var(--smoke)', textAlign: 'center' }}>
            No products yet. Add one to get started.
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
            {editing === product.id ? (
              /* Edit mode */
              <div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.75rem' }}>
                  <label style={labelStyle}>
                    Name
                    <input style={inputStyle} value={editFields.name} onChange={e => setEditFields(f => ({ ...f, name: e.target.value }))} />
                  </label>
                  <label style={labelStyle}>
                    Price (₦)
                    <input style={inputStyle} type="number" value={editFields.price} onChange={e => setEditFields(f => ({ ...f, price: e.target.value }))} />
                  </label>
                  <label style={labelStyle}>
                    Unit
                    <input style={inputStyle} value={editFields.unit} onChange={e => setEditFields(f => ({ ...f, unit: e.target.value }))} />
                  </label>
                  <label style={labelStyle}>
                    Low-stock alert at
                    <input style={inputStyle} type="number" value={editFields.lowStockThreshold} onChange={e => setEditFields(f => ({ ...f, lowStockThreshold: e.target.value }))} />
                  </label>
                </div>
                <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                  <button className="btn-ghost" style={smallBtnStyle} onClick={() => setEditing(null)}>Cancel</button>
                  <button className="btn-primary" style={smallBtnStyle} onClick={() => handleSaveEdit(product.id)} disabled={editSaving}>
                    {editSaving ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>
            ) : (
              /* View mode */
              <>
                <div className="flex-between" style={{ marginBottom: '0.75rem' }}>
                  <div>
                    <p style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9375rem' }}>{product.name}</p>
                    <p style={{ fontSize: '0.8125rem', color: 'var(--smoke)' }}>{product.unit}</p>
                  </div>
                  <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                    <p style={{ fontWeight: 700, color: 'var(--forest)' }}>₦{Number(product.price).toLocaleString()}</p>
                    {product.isLow && <span className="badge badge-red">Low stock</span>}
                    <button
                      className="btn-ghost"
                      style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem' }}
                      onClick={() => startEdit(product)}
                    >
                      Edit
                    </button>
                    <button
                      className="btn-ghost"
                      style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem', color: 'var(--danger)' }}
                      onClick={() => handleDelete(product.id)}
                      disabled={deleting === product.id}
                    >
                      {deleting === product.id ? '…' : 'Delete'}
                    </button>
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
                      onClick={() => handleSaveStock(product)}
                      disabled={saving === product.id || !(product.id in localStock)}
                    >
                      {saving === product.id ? 'Saving…' : 'Save stock'}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

const labelStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '0.25rem',
  fontSize: '0.8125rem',
  color: 'var(--smoke)',
  fontWeight: 500,
}

const inputStyle: React.CSSProperties = {
  padding: '0.4rem 0.6rem',
  borderRadius: 'var(--radius-sm)',
  border: '1.5px solid var(--ghost)',
  background: 'var(--cream)',
  color: 'var(--ink)',
  fontFamily: 'var(--font-body)',
  fontSize: '0.9rem',
  outline: 'none',
}

const smallBtnStyle: React.CSSProperties = {
  padding: '0.45rem 0.9rem',
  fontSize: '0.8125rem',
}