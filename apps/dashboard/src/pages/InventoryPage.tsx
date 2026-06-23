import { useMemo, useState, useEffect, useRef } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { AlertCircle, Plus, X, Share2, ImagePlus } from 'lucide-react'
import { TopBar } from '../components/ui/TopBar'
import { getSession } from '../lib/auth'
import { apiFetch } from '../lib/api'
import { useToast } from '../context/ToastContext'

type Product = {
  id: string
  name: string
  description: string | null
  price: string
  lastPrice: string | null
  aliases: string[]
  stockQuantity: number
  lowStockThreshold: number
  unit: string
  imageUrl: string | null
}

type EditFields = { name: string; price: string; lastPrice: string; aliases: string; unit: string; lowStockThreshold: string }
type AddForm   = { name: string; price: string; lastPrice: string; aliases: string; unit: string; stockQuantity: string; lowStockThreshold: string }

const emptyAdd: AddForm = { name: '', price: '', lastPrice: '', aliases: '', unit: 'unit', stockQuantity: '0', lowStockThreshold: '5' }

const field: React.CSSProperties = {
  display: 'flex', flexDirection: 'column', gap: '0.3rem',
  fontSize: '0.8125rem', color: 'var(--muted)', fontWeight: 500,
}
const inp: React.CSSProperties = {
  padding: '0.5rem 0.7rem',
  borderRadius: 'var(--r-sm)',
  border: '1.5px solid var(--line-2)',
  background: 'var(--paper-2)',
  color: 'var(--ink)',
  fontFamily: 'var(--fb)',
  fontSize: '0.9rem',
  outline: 'none',
  width: '100%',
}

function Drawer({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    const id = setTimeout(() => setReady(true), 320)
    return () => clearTimeout(id)
  }, [])

  return (
    <>
      <div className="drawer-backdrop" onClick={ready ? onClose : undefined} style={ready ? undefined : { pointerEvents: 'none' }} />
      <div className="drawer">
        <div className="drawer-handle" />
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div className="drawer-title" style={{ marginBottom: 0 }}>{title}</div>
          <button
            onClick={onClose}
            style={{ width: 32, height: 32, borderRadius: '50%', background: 'var(--paper-2)', border: '1px solid var(--line)', display: 'flex', alignItems: 'center', justifyContent: 'center', cursor: 'pointer', color: 'var(--muted)', flexShrink: 0 }}
          >
            <X size={16} strokeWidth={2} />
          </button>
        </div>
        {children}
      </div>
    </>
  )
}

export default function InventoryPage() {
  const session = getSession()
  const merchantId = session?.merchantId ?? ''
  const queryClient = useQueryClient()
  const { toast } = useToast()

  const [localStock, setLocalStock] = useState<Record<string, number>>({})
  const [saving, setSaving] = useState<string | null>(null)
  const [saveError, setSaveError] = useState<string | null>(null)

  const [editingProduct, setEditingProduct] = useState<Product | null>(null)
  const [editFields, setEditFields] = useState<EditFields>({ name: '', price: '', lastPrice: '', aliases: '', unit: '', lowStockThreshold: '' })
  const [editSaving, setEditSaving] = useState(false)

  const [showAdd, setShowAdd] = useState(false)
  const [addForm, setAddForm] = useState<AddForm>(emptyAdd)
  const [addSaving, setAddSaving] = useState(false)
  const [addError, setAddError] = useState<string | null>(null)

  const [deleting, setDeleting] = useState<string | null>(null)
  const [uploadingImage, setUploadingImage] = useState<string | null>(null)
  const [statusDrawer, setStatusDrawer] = useState<{ product: Product; caption: string } | null>(null)
  const [postingStatus, setPostingStatus] = useState(false)
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({})

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

  const lowCount = rows.filter(r => r.isLow).length

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

  function openEdit(product: Product) {
    setEditingProduct(product)
    setEditFields({
      name: product.name,
      price: Number(product.price).toString(),
      lastPrice: product.lastPrice == null ? '' : Number(product.lastPrice).toString(),
      aliases: (product.aliases ?? []).join(', '),
      unit: product.unit,
      lowStockThreshold: product.lowStockThreshold.toString(),
    })
  }

  function splitAliases(value: string) {
    return value.split(',').map(alias => alias.trim()).filter(Boolean)
  }

  async function handleSaveEdit() {
    if (!editingProduct) return
    setEditSaving(true)
    const res = await apiFetch(`/merchants/${merchantId}/products/${editingProduct.id}`, {
      method: 'PATCH',
      body: JSON.stringify({
        name: editFields.name,
        price: parseFloat(editFields.price),
        lastPrice: editFields.lastPrice.trim() ? parseFloat(editFields.lastPrice) : null,
        aliases: splitAliases(editFields.aliases),
        unit: editFields.unit,
        lowStockThreshold: parseInt(editFields.lowStockThreshold, 10),
      }),
    })
    if (res.ok) {
      await queryClient.invalidateQueries({ queryKey: ['products', merchantId] })
      setEditingProduct(null)
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
    if (editingProduct?.id === productId) setEditingProduct(null)
  }

  async function handleAdd() {
    setAddError(null)
    if (!addForm.name.trim()) { setAddError('Name is required'); return }
    if (!addForm.price || isNaN(parseFloat(addForm.price))) { setAddError('Valid price is required'); return }
    if (addForm.lastPrice.trim() && parseFloat(addForm.lastPrice) > parseFloat(addForm.price)) {
      setAddError('Last price cannot be higher than unit price'); return
    }
    setAddSaving(true)
    const res = await apiFetch(`/merchants/${merchantId}/products`, {
      method: 'POST',
      body: JSON.stringify({
        name: addForm.name.trim(),
        price: parseFloat(addForm.price),
        lastPrice: addForm.lastPrice.trim() ? parseFloat(addForm.lastPrice) : null,
        aliases: splitAliases(addForm.aliases),
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

  async function handleImageUpload(productId: string, file: File) {
    if (!file.type.startsWith('image/')) { toast('Only image files are supported'); return }
    if (file.size > 5 * 1024 * 1024) { toast('Image must be under 5MB'); return }
    setUploadingImage(productId)
    try {
      const buffer = await file.arrayBuffer()
      const res = await apiFetch(`/merchants/${merchantId}/products/${productId}/image`, {
        method: 'POST',
        headers: { 'Content-Type': file.type },
        body: buffer,
      })
      if (res.ok) {
        await queryClient.invalidateQueries({ queryKey: ['products', merchantId] })
        toast('Photo saved')
      } else {
        toast('Failed to upload image')
      }
    } catch {
      toast('Failed to upload image')
    }
    setUploadingImage(null)
  }

  function openStatusDrawer(product: Product) {
    const price = `₦${Number(product.price).toLocaleString()}`
    const caption = [`🛍️ *${product.name}*`, `💰 ${price}`, '', 'DM to order 📲'].join('\n')
    setStatusDrawer({ product, caption })
  }

  async function handlePostToStatus() {
    if (!statusDrawer) return
    setPostingStatus(true)
    try {
      const res = await apiFetch(`/merchants/${merchantId}/products/${statusDrawer.product.id}/post-to-status`, {
        method: 'POST',
        body: JSON.stringify({ caption: statusDrawer.caption }),
      })
      if (res.ok) {
        toast("Sent to your WhatsApp — forward it to your Status!")
        setStatusDrawer(null)
      } else {
        toast('Failed to send. Try again.')
      }
    } catch {
      toast('Failed to send. Try again.')
    }
    setPostingStatus(false)
  }

  const smBtn: React.CSSProperties = { padding: '0.55rem 1rem', fontSize: '0.875rem', borderRadius: 'var(--r-md)' }

  const drawerForm = <T extends EditFields | AddForm>(
    fields: T,
    setFields: React.Dispatch<React.SetStateAction<T>>,
    error?: string | null
  ) => (
    <>
      {error && (
        <div className="alert-error" style={{ marginBottom: '1rem' }}>
          <AlertCircle size={16} strokeWidth={2} />
          <span>{error}</span>
        </div>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '0.85rem', marginBottom: '0.85rem' }}>
        <label style={{ ...field, gridColumn: '1 / -1' }}>
          Product name
          <input style={inp} value={fields.name} onChange={e => setFields(f => ({ ...f, name: e.target.value }))} placeholder="e.g. Basmati Rice" />
        </label>
        <label style={field}>
          Price (₦)
          <input style={inp} type="number" value={fields.price} onChange={e => setFields(f => ({ ...f, price: e.target.value }))} placeholder="0" />
        </label>
        <label style={field}>
          Floor price (₦)
          <input style={inp} type="number" value={fields.lastPrice} onChange={e => setFields(f => ({ ...f, lastPrice: e.target.value }))} placeholder="No floor" />
        </label>
        <label style={field}>
          Unit
          <input style={inp} value={fields.unit} onChange={e => setFields(f => ({ ...f, unit: e.target.value }))} placeholder="bag, bottle, kg…" />
        </label>
        <label style={field}>
          Low-stock alert
          <input style={inp} type="number" value={fields.lowStockThreshold} onChange={e => setFields(f => ({ ...f, lowStockThreshold: e.target.value }))} />
        </label>
        {'stockQuantity' in fields && (
          <label style={{ ...field, gridColumn: '1 / -1' }}>
            Opening stock
            <input style={inp} type="number" value={(fields as AddForm).stockQuantity} onChange={e => setFields(f => ({ ...f, stockQuantity: e.target.value } as T))} />
          </label>
        )}
        <label style={{ ...field, gridColumn: '1 / -1' }}>
          Aliases <span style={{ fontWeight: 400, color: 'var(--subtle)' }}>(comma separated — what customers call it)</span>
          <input style={inp} value={fields.aliases} onChange={e => setFields(f => ({ ...f, aliases: e.target.value }))} placeholder="e.g. long grain, parboiled" />
        </label>
      </div>
    </>
  )

  return (
    <div className="pb-tab stagger">
      <TopBar
        title="Inventory"
        sub="Stock overview"
        right={
          <button
            className="btn btn-sm btn-primary"
            style={{ display: 'flex', alignItems: 'center', gap: 6 }}
            onClick={() => { setEditingProduct(null); setAddError(null); setAddForm(emptyAdd); setShowAdd(true) }}
          >
            <Plus size={15} strokeWidth={2.5} />
            Add
          </button>
        }
      />
      <div className="pad">
        {isLoading && <div style={{ color: 'var(--subtle)', textAlign: 'center', padding: 40 }}>Loading…</div>}

        {(error || saveError) && (
          <div className="alert-error" style={{ marginBottom: 12 }}>
            <AlertCircle size={16} strokeWidth={2} />
            <span>{(error as Error | null)?.message ?? saveError}</span>
          </div>
        )}

        {lowCount > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, background: 'rgba(201,145,42,.1)', border: '1px solid rgba(201,145,42,.3)', borderRadius: 'var(--r-md)', padding: '10px 14px', marginBottom: 14 }} className="fade-up">
            <AlertCircle size={16} strokeWidth={2} color="var(--amber)" style={{ flexShrink: 0 }} />
            <span style={{ fontWeight: 600, fontSize: 13.5, color: 'var(--amber)' }}>
              {lowCount} product{lowCount !== 1 ? 's' : ''} running low on stock
            </span>
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          {rows.length === 0 && !isLoading && (
            <div className="card card-pad tcenter" style={{ padding: 40, color: 'var(--muted)' }}>
              No products yet. Tap Add to get started.
            </div>
          )}
          {rows.map(product => (
            <div
              key={product.id}
              className="card fade-up"
              style={{
                padding: '1rem 1.25rem',
                borderColor: product.isLow ? 'rgba(201,145,42,.35)' : undefined,
                background: product.isLow ? 'rgba(201,145,42,.03)' : undefined,
              }}
            >
              {/* Product header with image */}
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, marginBottom: '0.75rem' }}>
                {/* Image slot */}
                <div style={{ position: 'relative', flexShrink: 0 }}>
                  {product.imageUrl ? (
                    <img
                      src={product.imageUrl}
                      alt={product.name}
                      style={{ width: 56, height: 56, borderRadius: 10, objectFit: 'cover', border: '1px solid var(--line)' }}
                    />
                  ) : (
                    <div style={{ width: 56, height: 56, borderRadius: 10, border: '1.5px dashed var(--line-2)', background: 'var(--paper-2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                      <ImagePlus size={18} strokeWidth={1.5} color="var(--subtle)" />
                    </div>
                  )}
                  <label
                    style={{ position: 'absolute', inset: 0, cursor: 'pointer', borderRadius: 10 }}
                    title={product.imageUrl ? 'Change photo' : 'Add photo'}
                  >
                    <input
                      type="file"
                      accept="image/*"
                      style={{ display: 'none' }}
                      ref={el => { fileInputRefs.current[product.id] = el }}
                      disabled={uploadingImage === product.id}
                      onChange={e => {
                        const file = e.target.files?.[0]
                        if (file) handleImageUpload(product.id, file)
                        e.target.value = ''
                      }}
                    />
                    {uploadingImage === product.id && (
                      <div style={{ position: 'absolute', inset: 0, borderRadius: 10, background: 'rgba(0,0,0,.4)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <span style={{ color: '#fff', fontSize: 10, fontWeight: 700 }}>…</span>
                      </div>
                    )}
                  </label>
                </div>

                {/* Name + price */}
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: 'var(--ink)', fontSize: '0.9375rem' }}>{product.name}</div>
                  <div style={{ fontSize: '0.8125rem', color: 'var(--muted)', marginTop: 2 }}>
                    {product.unit}
                    {product.aliases?.length > 0 && ` · ${product.aliases.join(', ')}`}
                  </div>
                </div>
                <div style={{ textAlign: 'right', flexShrink: 0 }}>
                  <div style={{ fontWeight: 700, color: 'var(--forest)', fontFamily: 'var(--fd)', fontSize: '1rem' }}>
                    ₦{Number(product.price).toLocaleString()}
                  </div>
                  {product.lastPrice && (
                    <div style={{ fontSize: '0.75rem', color: 'var(--muted)', marginTop: 1 }}>
                      floor: ₦{Number(product.lastPrice).toLocaleString()}
                    </div>
                  )}
                </div>
              </div>

              {/* Stock row */}
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '0.75rem' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button
                    onClick={() => setLocalStock(prev => ({ ...prev, [product.id]: Math.max(0, (prev[product.id] ?? product.stockQuantity) - 1) }))}
                    style={{ width: 30, height: 30, borderRadius: 8, border: '1.5px solid var(--line-2)', background: 'var(--paper-2)', fontWeight: 700, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                  >−</button>
                  <div style={{ textAlign: 'center', minWidth: 36 }}>
                    <div style={{ fontWeight: 800, fontSize: 20, fontFamily: 'var(--fd)', color: product.isLow ? 'var(--amber)' : 'var(--ink)', letterSpacing: '-.02em' }}>
                      {product.stockQuantity}
                    </div>
                    {product.isLow && (
                      <div style={{ fontSize: 9, fontWeight: 700, color: 'var(--amber)', textTransform: 'uppercase', letterSpacing: '.08em', marginTop: -2 }}>low</div>
                    )}
                  </div>
                  <button
                    onClick={() => setLocalStock(prev => ({ ...prev, [product.id]: (prev[product.id] ?? product.stockQuantity) + 1 }))}
                    style={{ width: 30, height: 30, borderRadius: 8, border: '1.5px solid var(--line-2)', background: 'var(--paper-2)', fontWeight: 700, fontSize: 16, cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}
                  >+</button>
                  {product.id in localStock && (
                    <button
                      className="btn btn-sm btn-mint"
                      style={{ padding: '0.35rem 0.85rem', fontSize: '0.8125rem' }}
                      onClick={() => handleSaveStock(product)}
                      disabled={saving === product.id}
                    >
                      {saving === product.id ? '…' : 'Save'}
                    </button>
                  )}
                </div>
                <div style={{ display: 'flex', gap: 6 }}>
                  <button
                    className="btn btn-sm btn-mint"
                    style={{ padding: '0.35rem 0.7rem', fontSize: '0.8125rem', display: 'flex', alignItems: 'center', gap: 4 }}
                    onClick={() => openStatusDrawer(product)}
                    title="Post to WhatsApp Status"
                  >
                    <Share2 size={13} strokeWidth={2} />
                    Status
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.8125rem' }}
                    onClick={() => openEdit(product)}
                  >
                    Edit
                  </button>
                  <button
                    className="btn btn-sm btn-ghost"
                    style={{ padding: '0.35rem 0.75rem', fontSize: '0.8125rem', color: 'var(--danger)', borderColor: 'rgba(192,73,47,.25)' }}
                    onClick={() => handleDelete(product.id)}
                    disabled={deleting === product.id}
                  >
                    {deleting === product.id ? '…' : 'Delete'}
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Add drawer */}
      {showAdd && (
        <Drawer title="Add product" onClose={() => setShowAdd(false)}>
          {drawerForm(addForm, setAddForm, addError)}
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button className="btn btn-md btn-ghost" style={smBtn} onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn btn-md btn-primary" style={{ ...smBtn, flex: 1 }} onClick={handleAdd} disabled={addSaving}>
              {addSaving ? 'Adding…' : 'Add product'}
            </button>
          </div>
        </Drawer>
      )}

      {/* Edit drawer */}
      {editingProduct && (
        <Drawer title={`Edit ${editingProduct.name}`} onClose={() => setEditingProduct(null)}>
          {drawerForm(editFields, setEditFields, null)}
          <div style={{ display: 'flex', gap: '0.75rem', marginBottom: 16 }}>
            <button className="btn btn-md btn-ghost" style={smBtn} onClick={() => setEditingProduct(null)}>Cancel</button>
            <button className="btn btn-md btn-primary" style={{ ...smBtn, flex: 1 }} onClick={handleSaveEdit} disabled={editSaving}>
              {editSaving ? 'Saving…' : 'Save changes'}
            </button>
          </div>
          <button
            className="btn btn-md btn-ghost"
            style={{ ...smBtn, width: '100%', color: 'var(--danger)', borderColor: 'rgba(192,73,47,.25)' }}
            onClick={() => handleDelete(editingProduct.id)}
            disabled={deleting === editingProduct.id}
          >
            {deleting === editingProduct.id ? 'Deleting…' : 'Delete product'}
          </button>
        </Drawer>
      )}

      {/* Post to Status drawer */}
      {statusDrawer && (
        <Drawer title="Post to Status" onClose={() => setStatusDrawer(null)}>
          {statusDrawer.product.imageUrl ? (
            <img
              src={statusDrawer.product.imageUrl}
              alt={statusDrawer.product.name}
              style={{ width: '100%', maxHeight: 180, objectFit: 'cover', borderRadius: 10, marginBottom: 16, border: '1px solid var(--line)' }}
            />
          ) : (
            <div style={{ background: 'var(--paper-2)', border: '1.5px dashed var(--line-2)', borderRadius: 10, padding: '16px', marginBottom: 16, textAlign: 'center', fontSize: 13, color: 'var(--muted)' }}>
              No product photo — a text card will be sent instead.{' '}
              <label style={{ color: 'var(--mint-deep)', fontWeight: 600, cursor: 'pointer' }}>
                Add photo
                <input
                  type="file"
                  accept="image/*"
                  style={{ display: 'none' }}
                  onChange={e => {
                    const file = e.target.files?.[0]
                    if (file) handleImageUpload(statusDrawer.product.id, file)
                    e.target.value = ''
                  }}
                />
              </label>
            </div>
          )}
          <label style={{ ...field, marginBottom: 16 }}>
            Caption
            <textarea
              style={{ ...inp, minHeight: 100, resize: 'vertical', lineHeight: 1.5 }}
              value={statusDrawer.caption}
              onChange={e => setStatusDrawer(d => d ? { ...d, caption: e.target.value } : d)}
            />
          </label>
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
            Mesa will send this to your WhatsApp number. Open WhatsApp and forward it to your Status.
          </div>
          <div style={{ display: 'flex', gap: '0.75rem' }}>
            <button className="btn btn-md btn-ghost" style={smBtn} onClick={() => setStatusDrawer(null)}>Cancel</button>
            <button
              className="btn btn-md btn-primary"
              style={{ ...smBtn, flex: 1 }}
              onClick={handlePostToStatus}
              disabled={postingStatus}
            >
              {postingStatus ? 'Sending…' : 'Send to WhatsApp'}
            </button>
          </div>
        </Drawer>
      )}
    </div>
  )
}
