import { createContext, useContext, useState, useCallback, useRef } from 'react'
import { Check } from 'lucide-react'

type ToastCtx = { toast: (msg: string) => void }
const Ctx = createContext<ToastCtx>({ toast: () => {} })

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [msg, setMsg] = useState<string | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const toast = useCallback((message: string) => {
    setMsg(message)
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setMsg(null), 2200)
  }, [])

  return (
    <Ctx.Provider value={{ toast }}>
      {children}
      {msg && (
        <div className="toast-wrap">
          <div className="toast">
            <span className="tcheck"><Check size={12} strokeWidth={3} /></span>
            {msg}
          </div>
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useToast() {
  return useContext(Ctx)
}
