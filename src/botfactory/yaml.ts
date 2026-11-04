/** A small YAML subset for BotFactory files: maps, lists, booleans, and plain strings. No anchors and no tabs. */
export function parseYaml(source: string): unknown {
  const lines: { indent: number; text: string }[] = []
  for (const raw of source.replaceAll('\r\n', '\n').split('\n')) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue
    if (raw.includes('\t')) throw new Error('YAML tabs are not allowed')
    const indent = raw.match(/^ */)?.[0].length ?? 0
    if (indent % 2 !== 0) throw new Error('Indent YAML by 2 spaces')
    lines.push({ indent, text: raw.slice(indent) })
  }
  if (!lines.length) return {}
  const [value, next] = readBlock(lines, 0, 0)
  if (next !== lines.length) throw new Error('YAML has more than one document')
  return value
}

function readBlock(lines: { indent: number; text: string }[], index: number, indent: number): [unknown, number] {
  if (index >= lines.length || lines[index]!.indent < indent) return [{}, index]
  return lines[index]!.text.startsWith('- ') ? readList(lines, index, indent) : readMap(lines, index, indent)
}

function readMap(lines: { indent: number; text: string }[], index: number, indent: number): [Record<string, unknown>, number] {
  const value: Record<string, unknown> = {}
  while (index < lines.length && lines[index]!.indent === indent && !lines[index]!.text.startsWith('- ')) {
    const text = lines[index]!.text
    const sep = text.indexOf(':')
    if (sep <= 0) throw new Error(`Expected a key in ${text}`)
    const key = text.slice(0, sep).trim()
    const rest = text.slice(sep + 1).trim()
    index += 1
    if (rest === '[]') value[key] = []
    else if (rest) value[key] = scalar(rest)
    else {
      const nested = readBlock(lines, index, indent + 2)
      value[key] = nested[0]
      index = nested[1]
    }
  }
  return [value, index]
}

function readList(lines: { indent: number; text: string }[], index: number, indent: number): [unknown[], number] {
  const value: unknown[] = []
  while (index < lines.length && lines[index]!.indent === indent && lines[index]!.text.startsWith('- ')) {
    const rest = lines[index]!.text.slice(2).trim()
    index += 1
    if (!rest) {
      const nested = readBlock(lines, index, indent + 2)
      value.push(nested[0])
      index = nested[1]
      continue
    }
    if (/^[A-Za-z0-9_]+:\s*\S/.test(rest)) {
      const item: Record<string, unknown> = {}
      const sep = rest.indexOf(':')
      item[rest.slice(0, sep).trim()] = scalar(rest.slice(sep + 1).trim())
      while (index < lines.length && lines[index]!.indent === indent + 2 && !lines[index]!.text.startsWith('- ')) {
        const text = lines[index]!.text
        const keySep = text.indexOf(':')
        if (keySep <= 0) throw new Error(`Expected a key in ${text}`)
        const itemRest = text.slice(keySep + 1).trim()
        if (!itemRest) throw new Error(`Expected a value in ${text}`)
        item[text.slice(0, keySep).trim()] = scalar(itemRest)
        index += 1
      }
      value.push(item)
      continue
    }
    value.push(scalar(rest))
  }
  return [value, index]
}

function scalar(raw: string): string | boolean {
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw.startsWith('"') && raw.endsWith('"') && raw.length >= 2) {
    return raw.slice(1, -1).replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  if (raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2) return raw.slice(1, -1).replace(/''/g, "'")
  return raw
}

/** Writes the subset `parseYaml` reads, with keys in insertion order. */
export function dumpYaml(value: unknown): string {
  return `${dump(value, 0).join('\n')}\n`
}

function dump(value: unknown, indent: number): string[] {
  if (Array.isArray(value)) return dumpList(value, indent)
  if (value && typeof value === 'object') return dumpMap(value as Record<string, unknown>, indent)
  return [dumpScalar(value)]
}

function dumpMap(value: Record<string, unknown>, indent: number): string[] {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue
    if (Array.isArray(item) && item.length === 0) lines.push(`${pad}${key}: []`)
    else if (Array.isArray(item) || (item && typeof item === 'object')) {
      lines.push(`${pad}${key}:`)
      lines.push(...dump(item, indent + 2))
    } else lines.push(`${pad}${key}: ${dumpScalar(item)}`)
  }
  return lines
}

function dumpList(value: unknown[], indent: number): string[] {
  const pad = ' '.repeat(indent)
  const lines: string[] = []
  for (const item of value) {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      const entries = Object.entries(item as Record<string, unknown>).filter(([, entry]) => entry !== undefined)
      const [first, ...rest] = entries
      if (!first) { lines.push(`${pad}- {}`); continue }
      lines.push(`${pad}- ${first[0]}: ${dumpScalar(first[1])}`)
      for (const [key, entry] of rest) lines.push(`${pad}  ${key}: ${dumpScalar(entry)}`)
      continue
    }
    lines.push(`${pad}- ${dumpScalar(item)}`)
  }
  return lines
}

function dumpScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  const text = String(value)
  if (text === '' || /[:#]/.test(text) || /^(true|false|null|\[])$/.test(text) || text !== text.trim()) {
    return `"${text.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
  }
  return text
}
