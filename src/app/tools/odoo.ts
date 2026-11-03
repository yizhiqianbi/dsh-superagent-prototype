/** Worker tools for one Odoo record: a CRM lead, or a manufacturing or sales order snapshot plus an internal note. */
import { z } from 'zod'
import type { Ticket, Trigger } from '../../core/index.ts'
import { tool, type Tool } from './tool.ts'
import { modelUnavailable, odooRpc, type OdooRpc } from '../../sources/odoo-rpc.ts'
import { classifyProduction } from '../../sources/odoo-progress.ts'
import { MRP_READ_FIELDS, ODOO_MODEL, READ_FIELDS, SALE_READ_FIELDS, SOURCE, WRITE_FIELDS, isRecordModel, type OdooRecordModel, type ReadField, type WriteField } from '../../sources/odoo-trigger.ts'
import { noteHtml } from '../../sources/odoo-channel.ts'

const ReadFieldSchema = z.enum(READ_FIELDS)
const WriteValuesSchema = z.object({
  phone: z.string().max(64).optional(),
  email_from: z.string().max(254).optional(),
  contact_name: z.string().max(200).optional(),
  partner_name: z.string().max(200).optional(),
  function: z.string().max(200).optional(),
  description: z.string().max(8000).optional(),
}).strict()

export const OdooSearchReadSchema = z.object({
  model: z.literal(ODOO_MODEL).default(ODOO_MODEL),
  fields: z.array(ReadFieldSchema).min(1).max(READ_FIELDS.length).optional(),
}).strict()
export const OdooWriteSchema = z.object({
  model: z.literal(ODOO_MODEL).default(ODOO_MODEL),
  values: WriteValuesSchema,
}).strict()
export const OdooMessagePostSchema = z.object({
  model: z.literal(ODOO_MODEL).default(ODOO_MODEL),
  body: z.string().trim().min(1).max(4000),
}).strict()

const MrpReadSchema = z.object({
  model: z.literal('mrp.production').default('mrp.production'),
  fields: z.array(z.enum(MRP_READ_FIELDS)).min(1).max(MRP_READ_FIELDS.length).optional(),
}).strict()
const SaleReadSchema = z.object({
  model: z.literal('sale.order').default('sale.order'),
  fields: z.array(z.enum(SALE_READ_FIELDS)).min(1).max(SALE_READ_FIELDS.length).optional(),
}).strict()
const MrpPostSchema = z.object({
  model: z.literal('mrp.production').default('mrp.production'),
  body: z.string().trim().min(1).max(4000),
}).strict()
const SalePostSchema = z.object({
  model: z.literal('sale.order').default('sale.order'),
  body: z.string().trim().min(1).max(4000),
}).strict()

export interface OdooToolsHost {
  readonly store: { triggers: { get(id: string): Trigger | undefined } }
}

/** The record this ticket started on. Throws when the ticket is not an Odoo activity on a listened model. */
export function odooRecord(host: OdooToolsHost, ticket: Ticket): { model: OdooRecordModel; resId: number; activityId: number } {
  const trigger = host.store.triggers.get(ticket.origin.triggerId)
  if (!trigger || trigger.source !== SOURCE) throw new Error('This ticket did not start on Odoo')
  const model = trigger.meta.model
  const resId = trigger.meta.resId
  if (typeof model !== 'string' || !isRecordModel(model) || typeof resId !== 'number' || !Number.isInteger(resId) || resId <= 0) throw new Error('This ticket has no Odoo record')
  const activityId = trigger.meta.activityId
  return { model, resId, activityId: typeof activityId === 'number' ? activityId : 0 }
}

/** The lead this ticket started on. Throws when the ticket is not an Odoo `crm.lead` activity. */
export function odooLead(host: OdooToolsHost, ticket: Ticket): { resId: number; activityId: number } {
  const record = odooRecord(host, ticket)
  if (record.model !== ODOO_MODEL) throw new Error('This ticket has no crm.lead')
  return { resId: record.resId, activityId: record.activityId }
}

function cell(value: unknown): unknown {
  return value === false ? null : value
}

function written(values: z.infer<typeof WriteValuesSchema>): Record<string, string> {
  const result: Record<string, string> = {}
  for (const field of WRITE_FIELDS) {
    const value = values[field]
    if (value === undefined) continue
    result[field] = field === 'description' ? noteHtml(value) : value.replace(/\s+/g, ' ').trim()
  }
  return result
}

function unavailable(model: string, error: unknown): { model: string; unavailable: true; reason: string } | undefined {
  if (!modelUnavailable(error)) return undefined
  return { model, unavailable: true, reason: `${model} is not installed on this Odoo; crm.lead activities still work` }
}

const DECLARED = { 'mrp.production': MRP_READ_FIELDS, 'sale.order': SALE_READ_FIELDS } as const

/**
 * The Odoo tools for this ticket. A lead keeps the contact whitelist. A manufacturing or sales order
 * gets a snapshot read and an internal note, and no field writes.
 */
export function odooExecutorTools(host: OdooToolsHost, ticket: Ticket, rpc: () => OdooRpc = odooRpc): Tool[] {
  const trigger = host.store.triggers.get(ticket.origin.triggerId)
  if (trigger?.source !== SOURCE) return []
  const model = trigger.meta.model
  if (model === ODOO_MODEL) return leadTools(host, ticket, rpc)
  if (model === 'mrp.production' || model === 'sale.order') return progressTools(host, ticket, model, rpc)
  return []
}

function leadTools(host: OdooToolsHost, ticket: Ticket, rpc: () => OdooRpc): Tool[] {
  return [
    tool({
      name: 'odoo_search_read',
      description: 'Read whitelisted fields of the crm.lead this ticket started on. model must be crm.lead. The record id is the ticket\'s lead; a domain is not accepted. fields defaults to the whitelist.',
      schema: OdooSearchReadSchema,
      execute: async (args, signal) => {
        const lead = odooLead(host, ticket)
        const fields: readonly ReadField[] = args.fields ?? READ_FIELDS
        const records = await rpc().searchRead(ODOO_MODEL, [['id', '=', lead.resId]], { fields, limit: 1 }, signal)
        return { model: ODOO_MODEL, res_id: lead.resId, records: records.map(record => Object.fromEntries(fields.filter(field => field in record).map(field => [field, cell(record[field])]))) }
      },
    }),
    tool({
      name: 'odoo_write',
      description: `Write whitelisted contact fields on the crm.lead this ticket started on. Allowed fields: ${WRITE_FIELDS.join(', ')}. Fill a field only when the activity states the value. Never invent a phone, email or name, and never write stage, user, team or revenue.`,
      schema: OdooWriteSchema,
      execute: async (args, signal) => {
        const lead = odooLead(host, ticket)
        const values = written(args.values)
        if (!Object.keys(values).length) throw new Error(`values needs at least one of: ${WRITE_FIELDS.join(', ')}`)
        await rpc().write(ODOO_MODEL, [lead.resId], values, signal)
        return { model: ODOO_MODEL, res_id: lead.resId, wrote: Object.keys(values) }
      },
    }),
    tool({
      name: 'odoo_message_post',
      description: 'Post one internal note on the crm.lead this ticket started on, saying which contact fields were filled and which stayed empty. model must be crm.lead.',
      schema: OdooMessagePostSchema,
      execute: async (args, signal) => {
        const lead = odooLead(host, ticket)
        const messageId = await rpc().messagePost(ODOO_MODEL, lead.resId, noteHtml(args.body), signal)
        return { model: ODOO_MODEL, res_id: lead.resId, message_id: messageId }
      },
    }),
  ]
}

function progressTools(host: OdooToolsHost, ticket: Ticket, model: 'mrp.production' | 'sale.order', rpc: () => OdooRpc): Tool[] {
  const declared = DECLARED[model]
  const readSchema = model === 'mrp.production' ? MrpReadSchema : SaleReadSchema
  const postSchema = model === 'mrp.production' ? MrpPostSchema : SalePostSchema
  return [
    tool({
      name: 'odoo_search_read',
      description: `Read the production snapshot of the ${model} this ticket started on. model must be ${model}. fields defaults to ${declared.join(', ')}; a field this Odoo does not have is skipped. The result includes progress.signal and, when the order is overdue, stale or short, progress.attention to copy into orchestrator_report human_action. This tool does not write.`,
      schema: readSchema,
      execute: async (args, signal) => {
        const record = odooRecord(host, ticket)
        if (record.model !== model) throw new Error(`This ticket is not on ${model}`)
        try {
          const available = await rpc().fieldsGet(model, signal)
          const requested = args.fields ?? declared
          const fields = requested.filter(field => Object.hasOwn(available, field))
          const skipped = requested.filter(field => !Object.hasOwn(available, field))
          if (!fields.length) throw new Error(`None of the snapshot fields exist on ${model}`)
          const rows = await rpc().searchRead(model, [['id', '=', record.resId]], { fields, limit: 1 }, signal)
          const records = rows.map(row => Object.fromEntries(fields.filter(field => field in row).map(field => [field, cell(row[field])])))
          const found = records[0]
          return {
            model, res_id: record.resId, fields, skipped, records,
            ...(found ? { progress: classifyProduction(model, found, new Date()) } : { unavailable: true, reason: `${model} ${record.resId} was not found` }),
          }
        } catch (error) {
          const missing = unavailable(model, error)
          if (missing) return { ...missing, res_id: record.resId }
          throw error
        }
      },
    }),
    tool({
      name: 'odoo_message_post',
      description: `Post one internal chase note on the ${model} this ticket started on. model must be ${model}. This does not change dates, quantities, stage or owner, and it does not send a customer email. On an overdue, stale or short order, skip this and copy progress.attention into orchestrator_report human_action instead.`,
      schema: postSchema,
      execute: async (args, signal) => {
        const record = odooRecord(host, ticket)
        if (args.model !== model || record.model !== model) throw new Error(`This ticket is not on ${model}`)
        try {
          const messageId = await rpc().messagePost(model, record.resId, noteHtml(args.body), signal)
          return { model, res_id: record.resId, message_id: messageId }
        } catch (error) {
          const missing = unavailable(model, error)
          if (missing) return { ...missing, res_id: record.resId }
          throw error
        }
      },
    }),
  ]
}

export type { WriteField }
