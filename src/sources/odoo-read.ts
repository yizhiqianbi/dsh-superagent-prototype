/** Chatter of the lead an activity is on, for an assessment's thread window. */
import type { Commands } from '../infra/commands.ts'
import type { Trigger } from '../core/index.ts'
import type { ContextMessage, ContextPart, ThreadContext } from './kind.ts'
import { odooRpc } from './odoo-rpc.ts'
import { ODOO_MODEL, odooTime } from './odoo-trigger.ts'

const PAGE = 20

function author(value: unknown): string {
  if (Array.isArray(value) && typeof value[1] === 'string') return value[1]
  if (Array.isArray(value) && typeof value[0] === 'number') return String(value[0])
  return ''
}

function textOf(value: unknown): string {
  if (typeof value !== 'string' || !value) return ''
  return value.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim()
}

function message(row: Record<string, unknown>): ContextMessage | undefined {
  if (typeof row.id !== 'number') return undefined
  const at = typeof row.date === 'string' ? odooTime(row.date) : ''
  return { id: String(row.id), from: author(row.author_id), at, text: textOf(row.body) }
}

/** The activity itself, so the trigger's message id is on the first page. */
function activityMessage(trigger: Trigger): ContextMessage {
  return { id: `activity:${String(trigger.meta.activityId ?? '')}`, from: trigger.actor.id, at: trigger.at, text: trigger.text }
}

async function chatter(resId: number, cursor: string | undefined, limit: number): Promise<ContextMessage[]> {
  const domain: unknown[] = [['model', '=', ODOO_MODEL], ['res_id', '=', resId]]
  if (cursor) domain.push(['id', '<', Number(cursor)])
  const rows = await odooRpc().searchRead('mail.message', domain, { fields: ['id', 'author_id', 'date', 'body'], limit, order: 'id desc' })
  return rows.flatMap(row => { const item = message(row); return item ? [item] : [] })
}

/** Thread context of a lead: the activity, then chatter pages of 20, newest first. `parent` has no separate message. */
export const odooThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => `activity:${String(trigger.meta.activityId ?? '')}`,
  async read(_commands: Commands, trigger: Trigger, part, cursor, _config: Record<string, unknown>): Promise<ContextPart> {
    const resId = Number(trigger.meta.resId)
    if (trigger.meta.model !== ODOO_MODEL || !Number.isInteger(resId) || resId <= 0) throw new Error('Missing Odoo lead')
    if (part === 'parent') return { messages: [], body: { messages: [] } }
    if (part === 'root') {
      const messages = await chatter(resId, undefined, 1)
      return { messages, body: { messages } }
    }
    if (part === 'thread') {
      const page = await chatter(resId, cursor, PAGE)
      const messages = cursor ? page : [activityMessage(trigger), ...page]
      const last = page[page.length - 1]
      const next = page.length === PAGE && last ? last.id : undefined
      return { messages, ...(next ? { next } : {}), body: { messages } }
    }
    const unreachable: never = part
    throw new Error(`Unknown Odoo thread part ${String(unreachable)}`)
  },
}
