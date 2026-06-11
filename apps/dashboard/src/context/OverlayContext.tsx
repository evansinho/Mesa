import { createContext, useContext, useState } from 'react'

export type Overlay =
  | { type: 'order-detail'; orderId: string }
  | { type: 'lend' }

type OverlayCtx = {
  overlay: Overlay | null
  openOverlay: (o: Overlay) => void
  closeOverlay: () => void
}

const Ctx = createContext<OverlayCtx>({
  overlay: null,
  openOverlay: () => {},
  closeOverlay: () => {},
})

export function OverlayProvider({ children }: { children: React.ReactNode }) {
  const [overlay, setOverlay] = useState<Overlay | null>(null)
  return (
    <Ctx.Provider value={{
      overlay,
      openOverlay: setOverlay,
      closeOverlay: () => setOverlay(null),
    }}>
      {children}
    </Ctx.Provider>
  )
}

export function useOverlay() {
  return useContext(Ctx)
}
