/** Upstream token formatter, retained without the unrelated Side Chat renderer. */


/** Compact token count the way the main conversation prints usage
 *  (517 / 12.2K / 1.2M — the host's own formatter is not exported). */
export function formatTokens(n: number): string {
  const scaled = (v: number): string => (v >= 100 ? String(Math.round(v)) : String(Math.round(v * 10) / 10))
  if (n < 1_000) return String(n)
  if (n < 1_000_000) return `${scaled(n / 1_000)}K`
  return `${scaled(n / 1_000_000)}M`
}
