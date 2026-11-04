/** Minimal XML-RPC codec for Odoo `/xmlrpc/2`: the values `execute_kw` sends and the responses it returns. */

/** An XML-RPC fault from Odoo. `faultString` is the message; a missing record is a fault, not an HTTP error. */
export class OdooFault extends Error {
  constructor(readonly faultCode: number, message: string) {
    super(message)
    this.name = 'OdooFault'
  }
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" }

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function unescapeXml(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-z]+);/g, (all, name: string) => {
    if (name.startsWith('#x')) return String.fromCodePoint(Number.parseInt(name.slice(2), 16))
    if (name.startsWith('#')) return String.fromCodePoint(Number.parseInt(name.slice(1), 10))
    return ENTITIES[name] ?? all
  })
}

/** Encode one XML-RPC value. Objects become structs, arrays become arrays, and `null` becomes `<nil/>`. */
export function encodeValue(value: unknown): string {
  if (value === null || value === undefined) return '<nil/>'
  if (typeof value === 'string') return `<string>${escapeXml(value)}</string>`
  if (typeof value === 'boolean') return `<boolean>${value ? '1' : '0'}</boolean>`
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Odoo XML-RPC cannot encode a non-finite number')
    return Number.isInteger(value) ? `<int>${value}</int>` : `<double>${value}</double>`
  }
  if (Array.isArray(value)) {
    return `<array><data>${value.map(item => `<value>${encodeValue(item)}</value>`).join('')}</data></array>`
  }
  if (typeof value === 'object') {
    const members = Object.entries(value as Record<string, unknown>).map(([name, item]) =>
      `<member><name>${escapeXml(name)}</name><value>${encodeValue(item)}</value></member>`).join('')
    return `<struct>${members}</struct>`
  }
  throw new Error(`Odoo XML-RPC cannot encode ${typeof value}`)
}

/** Encode one XML-RPC method call. */
export function encodeCall(method: string, params: readonly unknown[]): string {
  const body = params.map(param => `<param><value>${encodeValue(param)}</value></param>`).join('')
  return `<?xml version="1.0"?><methodCall><methodName>${escapeXml(method)}</methodName><params>${body}</params></methodCall>`
}

/** Read an XML-RPC method response. Throws `OdooFault` when the body is a fault. */
export function decodeResponse(xml: string): unknown {
  const parser = new Parser(xml)
  parser.skipMisc()
  parser.expect('methodResponse')
  parser.skipMisc()
  if (parser.peek('fault')) {
    parser.expect('fault')
    const fault = parser.value()
    parser.end('fault')
    parser.end('methodResponse')
    const record = fault && typeof fault === 'object' ? fault as { faultCode?: unknown; faultString?: unknown } : {}
    const code = typeof record.faultCode === 'number' ? record.faultCode : 0
    throw new OdooFault(code, typeof record.faultString === 'string' ? record.faultString : 'Odoo fault')
  }
  parser.expect('params')
  parser.expect('param')
  const value = parser.value()
  parser.end('param')
  parser.end('params')
  parser.end('methodResponse')
  return value
}

/**
 * Cursor over an XML-RPC document. It reads the subset Odoo returns: strings, ints, booleans, doubles,
 * arrays, structs, nil, datetimes and base64.
 */
class Parser {
  private at = 0
  constructor(private readonly xml: string) {}

  skipMisc(): void {
    for (;;) {
      this.skipSpace()
      if (this.xml.startsWith('<?', this.at)) { this.at = this.must(this.xml.indexOf('?>', this.at)) + 2; continue }
      if (this.xml.startsWith('<!--', this.at)) { this.at = this.must(this.xml.indexOf('-->', this.at)) + 3; continue }
      return
    }
  }

  peek(name: string): boolean {
    this.skipMisc()
    return this.xml.startsWith(`<${name}>`, this.at) || this.xml.startsWith(`<${name}/>`, this.at) || this.xml.startsWith(`<${name} />`, this.at)
  }

  expect(name: string): void {
    this.skipMisc()
    const open = `<${name}>`
    if (!this.xml.startsWith(open, this.at)) throw new Error(`Expected <${name}> in Odoo XML-RPC`)
    this.at += open.length
  }

  end(name: string): void {
    this.skipMisc()
    const close = `</${name}>`
    if (!this.xml.startsWith(close, this.at)) throw new Error(`Expected </${name}> in Odoo XML-RPC`)
    this.at += close.length
  }

  value(): unknown {
    this.skipMisc()
    if (this.xml.startsWith('<value>', this.at) || this.xml.startsWith('<value/>', this.at) || this.xml.startsWith('<value />', this.at)) {
      if (this.selfClosing('value')) return ''
      this.expect('value')
      this.skipMisc()
      if (this.xml.startsWith('</value>', this.at)) { this.end('value'); return '' }
      if (!this.xml.startsWith('<', this.at)) {
        const text = unescapeXml(this.textUntil('</value>'))
        this.end('value')
        return text
      }
      const inner = this.typed()
      this.end('value')
      return inner
    }
    return this.typed()
  }

  private typed(): unknown {
    this.skipMisc()
    const name = this.tagName()
    if (!name) throw new Error('Expected an XML-RPC value')
    if (this.selfClosing(name)) return name === 'nil' || name === 'string' ? (name === 'nil' ? null : '') : this.empty(name)
    this.expect(name)
    const value = this.contents(name)
    this.end(name)
    return value
  }

  private contents(name: string): unknown {
    switch (name) {
      case 'string': return unescapeXml(this.textUntil(`</${name}>`))
      case 'int':
      case 'i4': return Number.parseInt(this.textUntil(`</${name}>`), 10)
      case 'double': return Number(this.textUntil(`</${name}>`))
      case 'boolean': return this.textUntil(`</${name}>`).trim() === '1'
      case 'dateTime.iso8601': return this.textUntil(`</${name}>`)
      case 'base64': return this.textUntil(`</${name}>`).replace(/\s+/g, '')
      case 'nil': this.textUntil(`</${name}>`); return null
      case 'array': return this.array()
      case 'struct': return this.struct()
      default: throw new Error(`Unsupported XML-RPC type <${name}>`)
    }
  }

  private empty(name: string): unknown {
    switch (name) {
      case 'nil': return null
      case 'string':
      case 'base64':
      case 'dateTime.iso8601': return ''
      case 'int':
      case 'i4':
      case 'double': return 0
      case 'boolean': return false
      case 'array': return []
      case 'struct': return {}
      default: throw new Error(`Unsupported XML-RPC type <${name}>`)
    }
  }

  private array(): unknown[] {
    this.skipMisc()
    const wrapped = this.peek('data')
    if (wrapped) {
      if (this.selfClosing('data')) return []
      this.expect('data')
    }
    const items: unknown[] = []
    while (!(wrapped ? this.closing('data') : this.closing('array'))) items.push(this.value())
    if (wrapped) this.end('data')
    return items
  }

  private struct(): Record<string, unknown> {
    const record: Record<string, unknown> = {}
    while (!this.closing('struct')) {
      this.expect('member')
      this.expect('name')
      const name = unescapeXml(this.textUntil('</name>'))
      this.end('name')
      record[name] = this.value()
      this.end('member')
    }
    return record
  }

  private tagName(): string | undefined {
    this.skipMisc()
    const match = /^<([A-Za-z0-9.]+)/.exec(this.xml.slice(this.at))
    return match?.[1]
  }

  private selfClosing(name: string): boolean {
    this.skipMisc()
    for (const open of [`<${name}/>`, `<${name} />`]) {
      if (!this.xml.startsWith(open, this.at)) continue
      this.at += open.length
      return true
    }
    return false
  }

  private closing(name: string): boolean {
    this.skipMisc()
    return this.xml.startsWith(`</${name}>`, this.at)
  }

  private textUntil(marker: string): string {
    const end = this.xml.indexOf(marker, this.at)
    if (end < 0) throw new Error(`Unclosed XML-RPC value near ${marker}`)
    const text = this.xml.slice(this.at, end)
    this.at = end
    return text
  }

  private skipSpace(): void {
    while (this.at < this.xml.length && /\s/.test(this.xml[this.at]!)) this.at += 1
  }

  private must(index: number): number {
    if (index < 0) throw new Error('Truncated Odoo XML-RPC')
    return index
  }
}
