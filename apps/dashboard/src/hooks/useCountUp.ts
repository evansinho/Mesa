import { useState, useEffect, useRef } from 'react'

export function useCountUp(target: number, duration = 1000, run = true): number {
  const [value, setValue] = useState(target)
  const rafRef = useRef<number | null>(null)

  useEffect(() => {
    if (!run || target === 0) { setValue(target); return }
    const start = performance.now()
    const ease = (t: number) => 1 - Math.pow(1 - t, 3)
    const tick = (now: number) => {
      const progress = Math.min((now - start) / duration, 1)
      setValue(Math.round(ease(progress) * target))
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
    }
    setValue(0)
    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [target, duration, run])

  return value
}
