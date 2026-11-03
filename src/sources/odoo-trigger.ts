/** One Odoo `mail.activity` as a Trigger. The id is the activity id, so a poll can read it twice. */
import { z } from 'zod'
import { key, type Trigger } from '../core/index.ts'

export const SOURCE = 'odoo'
/** CRM model. Contact writes stay on this model only. */
export const ODOO_MODEL = 'crm.lead'
/**
 * Models a poll may listen to. `mrp.production` and `sale.order` are the production-progress extension.
 * A database without one of them still polls the others.
 */
export const ODOO_RECORD_MODELS = ['crm.lead', 'mrp.production', 'sale.order'] as const
export type OdooRecordModel = typeof ODOO_RECORD_MODELS[number]
/** Models whose absence is a health note, not a failed poll. `crm.lead` is always required. */
export const OPTIONAL_MODELS = ['mrp.production', 'sale.order'] as const
/** Fields `odoo_write` may change. They are contact fields on `crm.lead`; stage, owner and revenue are not among them. */
export const WRITE_FIELDS = ['phone', 'email_from', 'contact_name', 'partner_name', 'function', 'description'] as const
/** Fields `odoo_search_read` may return for a lead. The write fields, plus enough of the lead to see what is already filled. */
export const READ_FIELDS = ['id', 'name', 'type', 'partner_id', 'street', 'city', 'website', ...WRITE_FIELDS] as const
/**
 * Manufacturing snapshot. `fields_get` drops whichever of these the connected Odoo does not have.
 * `write_date` is the progress-update clock. Nothing here is written back.
 */
export const MRP_READ_FIELDS = ['id', 'name', 'state', 'product_id', 'product_qty', 'qty_producing', 'qty_produced', 'date_start', 'date_finished', 'date_deadline', 'origin', 'write_date'] as const
/** Sales-order header snapshot. Quantity lives on the lines, so a shortfall is not read from this header. */
export const SALE_READ_FIELDS = ['id', 'name', 'state', 'partner_id', 'date_order', 'commitment_date', 'expected_date', 'origin', 'write_date'] as const
export type WriteField = typeof WRITE_FIELDS[number]
export type ReadField = typeof READ_FIELDS[number]
export type MrpReadField = typeof MRP_READ_FIELDS[number]
export type SaleReadField = typeof SALE_READ_FIELDS[number]

/** True for a model this Source listens to. */
export function isRecordModel(model: string): model is OdooRecordModel {
  return (ODOO_RECORD_MODELS as readonly string[]).includes(model)
}

/** Thread label for a related record. Unknown models still get a label; scope drops them. */
export function recordThread(model: string, resId: number): { label: string; fact: string; factLabel: { zh: string; en: string } } {
  switch (model) {
    case 'crm.lead':
      return { label: `Lead ${resId}`, fact: 'lead', factLabel: { zh: '线索', en: 'Lead' } }
    case 'mrp.production':
      return { label: `Manufacturing order ${resId}`, fact: 'production', factLabel: { zh: '制造订单', en: 'Manufacturing order' } }
    case 'sale.order':
      return { label: `Sales order ${resId}`, fact: 'order', factLabel: { zh: '销售订单', en: 'Sales order' } }
    default:
      return { label: `${model} ${resId}`, fact: 'record', factLabel: { zh: '记录', en: 'Record' } }
  }
}

const Many2oneSchema = z.union([z.tuple([z.number().int(), z.string()]), z.literal(false)])
const TextSchema = z.union([z.string(), z.literal(false)])
/** One `mail.activity` row as `search_read` returns it. Extra keys are ignored. */
export const ActivitySchema = z.looseObject({
  id: z.number().int().positive(),
  res_model: z.string().min(1),
  res_id: z.number().int().positive(),
  summary: TextSchema.optional(),
  note: TextSchema.optional(),
  user_id: Many2oneSchema,
  create_uid: Many2oneSchema,
  create_date: z.string().min(1),
})
export type OdooActivity = z.infer<typeof ActivitySchema>

/** Activities assigned to the agent, newer than `afterId`, oldest first. `models` defaults to every listened model. */
export function activityDomain(afterId: number, agentUid: number, models: readonly string[] = ODOO_RECORD_MODELS): unknown[] {
  return [['id', '>', afterId], ['res_model', 'in', [...models]], ['user_id', '=', agentUid]]
}

/** Odoo datetimes have no zone and are UTC (`2026-11-04 03:54:00`). The result is the canonical ISO form the Engine stores. */
export function odooTime(value: string): string {
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? `${value.replace(' ', 'T')}Z` : value
  const parsed = Date.parse(iso)
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : value
}

/** Form URL of a record. Empty when the base URL is empty. */
export function recordUrl(baseUrl: string, model: string, resId: number): string {
  const base = baseUrl.replace(/\/$/, '')
  return base ? `${base}/web#id=${resId}&model=${model}&view_type=form` : ''
}

/** Form URL of a lead. Empty when the base URL is empty. */
export function leadUrl(baseUrl: string, resId: number): string {
  return recordUrl(baseUrl, ODOO_MODEL, resId)
}

function plain(value: string | false | undefined): string {
  if (!value) return ''
  return value
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

function many2oneId(value: OdooActivity['user_id']): number | undefined {
  return value === false ? undefined : value[0]
}

/**
 * The Trigger of one activity assigned to the agent. The agent's own activity produces none.
 * `addressed` is `direct` when `user_id` is the agent, which is how this Source is addressed.
 */
export function odooTrigger(activity: OdooActivity, agentUid: number, baseUrl: string): Trigger | undefined {
  const creator = many2oneId(activity.create_uid)
  if (creator === undefined || creator === agentUid) return undefined
  const assignee = many2oneId(activity.user_id)
  const summary = plain(activity.summary)
  const note = plain(activity.note)
  const text = [summary, note].filter(Boolean).join('\n') || `Activity ${activity.id} on ${activity.res_model} ${activity.res_id}`
  const url = isRecordModel(activity.res_model) ? recordUrl(baseUrl, activity.res_model, activity.res_id) : ''
  const thread = `${activity.res_model}:${activity.res_id}`
  return {
    id: key(SOURCE, 'activity', String(activity.id)),
    source: SOURCE,
    threads: [{ source: SOURCE, id: thread }],
    actor: { source: SOURCE, id: String(creator) },
    human: true,
    ...(assignee === agentUid ? { addressed: 'direct' as const } : {}),
    at: odooTime(activity.create_date),
    text,
    channel: { source: SOURCE, thread: `${SOURCE}:${thread}`, address: { model: activity.res_model, res_id: String(activity.res_id) } },
    ...(url ? { url } : {}),
    meta: { model: activity.res_model, resId: activity.res_id, activityId: activity.id, userId: assignee ?? null, createUid: creator },
  }
}
