import { useState, useCallback } from 'react'

export function useTheme() {
  const [isDark, setIsDark] = useState(
    () => document.documentElement.getAttribute('data-theme') === 'dark'
  )

  const toggle = useCallback(() => {
    setIsDark(prev => {
      const next = !prev
      if (next) {
        document.documentElement.setAttribute('data-theme', 'dark')
        try { localStorage.setItem('mesa_theme', 'dark') } catch {}
      } else {
        document.documentElement.removeAttribute('data-theme')
        try { localStorage.removeItem('mesa_theme') } catch {}
      }
      return next
    })
  }, [])

  return { isDark, toggle }
}
