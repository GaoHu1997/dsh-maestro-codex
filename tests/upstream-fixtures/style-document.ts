export function styleDocument() {
  const styles = new Map<string, { id: string; textContent: string; attributes: Record<string, string> }>()
  const parent = {
    appendChild(style: { id: string; textContent: string; attributes: Record<string, string> }) {
      styles.set(style.id, style)
      return style
    },
  }
  return {
    styles,
    document: {
      head: parent,
      documentElement: parent,
      getElementById: (id: string) => styles.get(id) ?? null,
      createElement: () => ({
        id: '', textContent: '', attributes: {} as Record<string, string>,
        setAttribute(key: string, value: string) { this.attributes[key] = value },
      }),
    },
  }
}
