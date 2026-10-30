/** Install the compiled upstream stylesheet when the host loads its client factory. */
export function injectUpstreamStylesheet(id: string, text: string): void {
  if (typeof document === 'undefined') return
  const existing = document.getElementById(id)
  if (existing !== null) {
    if (existing.textContent !== text) existing.textContent = text
    return
  }
  const parent = document.head ?? document.documentElement
  if (parent === null) return
  const style = document.createElement('style')
  style.id = id
  style.setAttribute('data-dsh-maestro-upstream', '0.28.2')
  style.textContent = text
  parent.appendChild(style)
}
