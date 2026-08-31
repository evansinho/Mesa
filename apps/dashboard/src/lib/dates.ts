// Shared by any page with a custom date-range picker (Money, Orders) —
// dates are plain YYYY-MM-DD strings, matching what the API's from/to
// query params expect (both interpreted as Africa/Lagos calendar days).

export function todayDateString(): string {
  return new Date().toISOString().slice(0, 10)
}

export function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00.000Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

export function formatPickedDate(d: string): string {
  return new Date(`${d}T00:00:00`).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })
}
