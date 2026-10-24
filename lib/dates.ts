// Date -> 'YYYY-MM-DD' in local (Sydney) time
export function toYMD(d: Date) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

// 'YYYY-MM-DD' -> Date at local midnight
export function fromYMD(s: string) {
  const [y, m, d] = s.split('-').map(Number)
  return new Date(y, m - 1, d)
}

// '08:30:00' -> '8:30am'
export function fmtTime(t: string) {
  const [h, m] = t.split(':').map(Number)
  const hr = h % 12 === 0 ? 12 : h % 12
  return `${hr}${m ? ':' + String(m).padStart(2, '0') : ''}${h >= 12 ? 'pm' : 'am'}`
}

// '2026-10-27' -> 'Tue 27 Oct'
export function fmtDate(s: string) {
  return fromYMD(s).toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' })
}

// Today's date in Sydney as 'YYYY-MM-DD', correct on both the browser and the server
export function sydneyToday() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Australia/Sydney' })
}