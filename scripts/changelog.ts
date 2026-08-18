function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export function hasChangelogVersionHeading(markdown: string, version: string): boolean {
  if (!version)
    return false

  const heading = new RegExp(`^## \\[${escapeRegExp(version)}\\](?:\\s+-\\s+\\d{4}-\\d{2}-\\d{2})?\\s*$`)
  let fence: { marker: '`' | '~', length: number } | null = null
  for (const line of markdown.split(/\r?\n/)) {
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})/)
    if (fenceMatch?.[1]) {
      const marker = fenceMatch[1][0] as '`' | '~'
      if (!fence) {
        fence = { marker, length: fenceMatch[1].length }
      }
      else if (
        marker === fence.marker
        && fenceMatch[1].length >= fence.length
        && line.slice(line.indexOf(fenceMatch[1]) + fenceMatch[1].length).trim() === ''
      ) {
        fence = null
      }
      continue
    }
    if (!fence && heading.test(line))
      return true
  }
  return false
}
