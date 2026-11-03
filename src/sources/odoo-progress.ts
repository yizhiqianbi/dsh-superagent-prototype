/**
 * Deterministic production-progress reading of one manufacturing or sales snapshot.
 * The worker copies `attention` into `orchestrator_report` `human_action`. The panel already shows that question.
 */
export const PROGRESS_SLA_HOURS = 24

const SLA_MS = PROGRESS_SLA_HOURS * 60 * 60 * 1000
const CLOSED = new Set(['done', 'cancel'])

export type ProgressSignal = 'on_track' | 'overdue' | 'stale' | 'shortfall'
export type ProgressRecommendation = 'chase' | 'reschedule' | 'shortage'
export interface ProductionProgress {
  signal: ProgressSignal
  /** Which option the question recommends. Absent when the order is on track. */
  recommendation?: ProgressRecommendation
  /** Markdown question for Attention. Absent when the order is on track. At most 1000 characters. */
  attention?: string
}

const RISK = 'Risk: date changes, expediting, customer promises, QC release and payment stay with a person. The agent does not reschedule and does not send a customer email.'
const OPTIONS: Record<ProgressRecommendation, { label: string; detail: string }> = {
  chase: { label: '继续催', detail: 'Post another internal chase and keep the planned date.' },
  reschedule: { label: '建议改期给人确认', detail: 'A person confirms a new date in Odoo. The agent does not write it.' },
  shortage: { label: '升级缺料异常', detail: 'Record a material shortage for a person. No reschedule and no customer email.' },
}
const OPTION_ORDER: readonly ProgressRecommendation[] = ['chase', 'reschedule', 'shortage']

/** Odoo UTC datetime (`2026-11-04 03:54:00`) or date (`2026-11-04`). A date counts through the end of that UTC day when `endOfDay` is set. */
export function odooInstant(value: unknown, endOfDay: boolean): number | undefined {
  if (typeof value !== 'string') return undefined
  const text = value.trim()
  const stamp = /^\d{4}-\d{2}-\d{2}$/.test(text)
    ? `${text}T${endOfDay ? '23:59:59' : '00:00:00'}Z`
    : /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(text) ? `${text.replace(' ', 'T')}Z` : ''
  if (!stamp) return undefined
  const parsed = Date.parse(stamp)
  return Number.isFinite(parsed) ? parsed : undefined
}

function dueFields(model: 'mrp.production' | 'sale.order'): readonly string[] {
  switch (model) {
    case 'mrp.production': return ['date_deadline', 'date_finished']
    case 'sale.order': return ['commitment_date', 'expected_date']
    default: {
      const unreachable: never = model
      throw new Error(`Unknown production model ${String(unreachable)}`)
    }
  }
}

function firstDue(record: Record<string, unknown>, fields: readonly string[]): { field: string; at: number; raw: string } | undefined {
  for (const field of fields) {
    const raw = record[field]
    const at = odooInstant(raw, true)
    if (at !== undefined && typeof raw === 'string') return { field, at, raw: raw.trim() }
  }
  return undefined
}

function clip(text: string): string {
  const trimmed = text.trim()
  return trimmed.length <= 80 ? trimmed : `${trimmed.slice(0, 79)}…`
}

function shown(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return clip(value)
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (Array.isArray(value)) {
    if (typeof value[1] === 'string' && value[1].trim()) return clip(value[1])
    if (typeof value[0] === 'number') return String(value[0])
  }
  return undefined
}

function shortfall(record: Record<string, unknown>): { planned: number; produced: number } | undefined {
  const planned = record.product_qty
  const produced = record.qty_produced
  if (typeof planned !== 'number' || typeof produced !== 'number' || !(planned > 0) || produced >= planned) return undefined
  return { planned, produced }
}

function kindLabel(model: 'mrp.production' | 'sale.order', record: Record<string, unknown>): string {
  const kind = model === 'mrp.production' ? 'Manufacturing order' : 'Sales order'
  const name = shown(record.name)
  return name ? `${kind} ${name.slice(0, 80)}` : kind
}

function contextOf(record: Record<string, unknown>, due: { field: string; raw: string } | undefined): string {
  const state = shown(record.state)
  const product = shown(record.product_id)
  const bits = [
    due ? `${due.field} ${due.raw}` : '',
    state ? `state ${state}` : '',
    product ? `product ${product}` : '',
    typeof record.product_qty === 'number' ? `planned ${record.product_qty}` : '',
    typeof record.qty_produced === 'number' ? `produced ${record.qty_produced}` : '',
    typeof record.qty_producing === 'number' ? `producing ${record.qty_producing}` : '',
  ].filter(Boolean)
  return bits.join(', ')
}

function question(headline: string, context: string, recommendation: ProgressRecommendation): string {
  const lines = OPTION_ORDER.map((id, index) => {
    const option = OPTIONS[id]
    const mark = id === recommendation ? ' Recommended.' : ''
    return `${index + 1}. ${option.label} — ${option.detail}${mark}`
  })
  const tail = [`Recommendation: ${OPTIONS[recommendation].label}.`, RISK, ...lines].join('\n')
  const head = context ? `${headline} (${context}).` : `${headline}.`
  const text = `${head}\n${tail}`
  if (text.length <= 1000) return text
  const room = 1000 - tail.length - 1
  return room > 1 ? `${head.slice(0, room)}\n${tail}` : tail.slice(0, 1000)
}

/**
 * Classify one snapshot. `done` and `cancel` are on track. A manufacturing order past its date with
 * `qty_produced` below `product_qty` is a shortfall. Any other passed planned date is overdue.
 * Otherwise a `write_date` older than {@link PROGRESS_SLA_HOURS} is stale. Sales headers have no quantity, so they never shortfall.
 */
export function classifyProduction(model: 'mrp.production' | 'sale.order', record: Record<string, unknown>, now: Date): ProductionProgress {
  const state = typeof record.state === 'string' ? record.state : ''
  if (CLOSED.has(state)) return { signal: 'on_track' }
  const due = firstDue(record, dueFields(model))
  const overdue = due !== undefined && due.at < now.getTime()
  const gap = model === 'mrp.production' ? shortfall(record) : undefined
  const label = kindLabel(model, record)
  const context = contextOf(record, due)
  if (overdue && gap) {
    return { signal: 'shortfall', recommendation: 'shortage', attention: question(`${label} is past its planned date and still short (${gap.produced} of ${gap.planned} produced)`, context, 'shortage') }
  }
  if (overdue) {
    return { signal: 'overdue', recommendation: 'reschedule', attention: question(`${label} is past its planned date`, context, 'reschedule') }
  }
  const written = odooInstant(record.write_date, false)
  if (written !== undefined && now.getTime() - written >= SLA_MS) {
    return { signal: 'stale', recommendation: 'chase', attention: question(`${label} has had no progress update for ${PROGRESS_SLA_HOURS} hours`, context, 'chase') }
  }
  return { signal: 'on_track' }
}
