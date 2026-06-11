import { useMemo, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Plus } from 'lucide-react'
import { TopBar } from '../components/ui/TopBar'
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

type EditFields = { name: string; price: string; unit: string; lowStockThreshold: string }
type AddForm   = { name: string; price: string; unit: string; stockQuantity: string; lowStockThreshold: string }

const emptyAdd: AddForm = { name: '', price: '', unit: 'unit', stockQuantity: '0', lowStockThreshold: '5' }

const field: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '0.25rem',
  fontSize: '0.8125rem', color: 'var(--muted)', fontWeight: 500,
}
const inp: React.CSSProperties = {
  padding: '0.45rem 0.65rem',
  borderRadius: 'var(--r-sm)',
  border: '1.5px solid var(--line-2)',
  background: 'var(--paper-2)',
  color: 'var(--ink)',
  fontFamily: 'var(--fb)',
  fontSize: '0.875rem',
  outline: 'none',
}
const smBtn: React.CSSProperties = { padding: '0.45rem 1rem', fontSize: '0.8125rem' }

export default function InventoryPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const queryClient = useQueryClient()

  const [localStock, setLocalStock] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [editing, setEditing] = useState<string | null>(null)
  const [editFields, setEditFields] = useState<EditFields>({ name: '', price: '', unit: '', lowStockThreshold: '' })
  const [editSaving, setEditSaving] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState<AddForm>(emptyAdd)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

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

  const rows = useMemo(() => (data ?? []).map(p => ({
    ...p,
    stockQuantity: localStock[p.id] ?? p.stockQuantity,
    isLow: (localStock[p.id] ?? p.stockQuantity) <= p.lowStockThreshold,
  })), [data, localStock])

  async function handleSaveStock(product: typeof rows[number]) {
    setSaving(product.id); setSaveError(null)
    const res = await apiFetch(`/merchants/${merchantId}/products/${product.id}`, {
      method: 'PATCH',
      body: JSON.stringify({ stockQuantity: product.stockQuantity }),
    })
    if (!res.ok) { setSaveError('Failed to update stock') }
    else {
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
    } else { setSaveError('Failed to update product') }
    setEditSaving(false)
  }

  async function handleDelete(productId: string) {
    if (!confirm('Delete this product? This cannot be undone.')) return
    setDeleting(productId)
    const res = await apiFetch(`/merchants/${merchantId}/products/${productId}`, { method: 'DELETE' })
    if (res.ok) { await queryClient.invalidateQueries({ queryKey: ['products', merchantId] }) }
    else { setSaveError('Failed to delete product') }
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
      setShowAdd(false); setAddForm(emptyAdd)
    } else { setAddError('Failed to add product') }
    setAddSaving(false)
  }

  return (
    <div className="pb-tab stagger">
      <TopBar
        title="Inventory"
        sub="Stock overview"
        right={
          <button
            className="btn btn-sm btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => { setShowAdd(true); setAddError(null); setAddForm(emptyAdd) }}
          >
            <Plus size={15} strokeWidth={2.5} />
            Add
          </button>
        }
      />
      <div className="pad">
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}
        {(error || saveError) && (
          <div style={{ color: 'var(--danger)', fontSize: '0.875rem', marginBottom: 12 }}>
            {(error as Error | null)?.message ?? saveError}
          </div>
        )}

        {/* Add product form */}
        {showAdd && (
          <div className="card card-pad fade-up" style={{ marginBottom: 14, border: '1.5px solid var(--forest)' }}>
            <div style={{ fontWeight: 600, marginBottom: '1rem', color: 'var(--ink)' }}>New product</div>
            {addError && <div style={{ color: 'var(--danger)', fontSize: '0.8125rem', marginBottom: '0.75rem' }}>{addError}</div>}
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.75rem', marginBottom: '0.75rem' }}>
              <label style={field}>Name<input style={inp} value={addForm.name} onChange={e => setAddForm(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Basmati Rice" /></label>
              <label style={field}>Unit price (₦)<input style={inp} type="number" value={addForm.price} onChange={e => setAddForm(f => ({ ...f, price: e.target.value }))} placeholder="0" /></label>
              <label style={field}>Unit<input style={inp} value={addForm.unit} onChange={e => setAddForm(f => ({ ...f, unit: e.target.value }))} placeholder="bag, bottle, kg…" /></label>
              <label style={field}>Opening stock<input style={inp} type="number" value={addForm.stockQuantity} onChange={e => setAddForm(f => ({ ...f, stockQuantity: e.target.value }))} /></label>
              <label style={field}>Low-stock alert at<input style={inp} type="number" value={addForm.lowStockThreshold} onChange={e => setAddForm(f => ({ ...f, lowStockThreshold: e.target.value }))} /></label>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
              <button className="btn btn-sm btn-ghost" style={smBtn} onClick={() => setShowAdd(false)}>Cancel</button>
              <button className="btn btn-sm btn-primary" style={smBtn} onClick={handleAdd} disabled={addSaving}>
                {addSaving ? 'Adding…' : 'Add product'}
              </button>
            </div>
          </div>
        )}

        {/* Product list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {rows.length === 0 && !isLoading && !showAdd && (
            <div className="card card-pad tcenter" style={{ padding: 40, color: 'var(--muted)' }}>
              No products yet. Add one to get started.
            </div>
          )}
          {rows.map(product => (
            <div
              key={product.id}
              className="card fade-up"
              style={{
                padding: '1rem 1.25rem',
                borderColor: product.isLow ? 'rgba(192,73,47,.3)' : undefined,
                background: product.isLow ? 'rgba(192,73,47,.04)' : undefined,
              }}
            >
              {editing === product.id ? (
                <div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.6rem', marginBottom: '0.75rem' }}>
                    <label style={field}>Name<input style={inp} value={editFields.name} onChange={e => setEditFields(f => ({ ...f, name: e.target.value }))} /></label>
                    <label style={field}>Price (₦)<input style={inp} type="number" value={editFields.price} onChange={e => setEditFields(f => ({ ...f, price: e.target.value }))} /></label>
                    <label style={field}>Unit<input style={inp} value={editFields.unit} onChange={e => setEditFields(f => ({ ...f, unit: e.target.value }))} /></label>
                    <label style={field}>Low-stock alert at<input style={inp} type="number" value={editFields.lowStockThreshold} onChange={e => setEditFields(f => ({ ...f, lowStockThreshold: e.target.value }))} /></label>
                  </div>
                  <div style={{ display: 'flex', gap: '0.5rem', justifyContent: 'flex-end' }}>
                    <button className="btn btn-sm btn-ghost" style={smBtn} onClick={() => setEditing(null)}>Cancel</button>
                    <button className="btn btn-sm btn-primary" style={smBtn} onClick={() => handleSaveEdit(product.id)} disabled={editSaving}>
                      {editSaving ? 'Saving…' : 'Save'}
                    </button>
                  </div>
                </div>
              ) : (
                <>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: '0.75rem' }}>
                    <div>
                      <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9375rem' }}>{product.name}</div>
                      <div style={{ fontSize: '0.8125rem', color: 'var(--muted)', marginTop: 2 }}>{product.unit}</div>
                    </div>
                    <div style={{ textAlign: 'right', display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <div style={{ fontWeight: 700, color: 'var(--forest)', fontFamily: 'var(--fd)' }}>₦{Number(product.price).toLocaleString()}</div>
                      {product.isLow && <span className="badge badge-danger">Low stock</span>}
                      <button className="btn btn-sm btn-ghost" style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem' }} onClick={() => startEdit(product)}>Edit</button>
                      <button
                        className="btn btn-sm btn-ghost"
                        style={{ padding: '0.3rem 0.55rem', fontSize: '0.75rem', color: 'var(--danger)', borderColor: 'rgba(192,73,47,.3)' }}
                        onClick={() => handleDelete(product.id)}
                        disabled={deleting === product.id}
                      >
                        {deleting === product.id ? '…' : 'Delete'}
                      </button>
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <label style={{ fontSize: '0.8125rem', color: 'var(--muted)', fontWeight: 500 }}>Stock:</label>
                      <input
                        type="number"
                        value={product.stockQuantity}
                        onChange={e => setLocalStock(prev => ({ ...prev, [product.id]: Number(e.target.value) }))}
                        style={{
                          ...inp,
                          width: 80,
                          borderColor: product.isLow ? 'rgba(192,73,47,.4)' : undefined,
                          color: product.isLow ? 'var(--danger)' : 'var(--ink)',
                        }}
                      />
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                      <span style={{ fontSize: '0.8125rem', color: 'var(--muted)' }}>Min: {product.lowStockThreshold}</span>
                      <button
                        className="btn btn-sm btn-ghost"
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
      </div>
    </div>
  )
}
