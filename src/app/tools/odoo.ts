/** Worker tools for one Odoo CRM lead: read it, write whitelisted contact fields, and post an internal note. */
import { z } from 'zod'
import type { Ticket, Trigger } from '../../core/index.ts'
import { tool, type Tool } from './tool.ts'
import { odooRpc, type OdooRpc } from '../../sources/odoo-rpc.ts'
import { ODOO_MODEL, READ_FIELDS, SOURCE, WRITE_FIELDS, type ReadField, type WriteField } from '../../sources/odoo-trigger.ts'
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

export interface OdooToolsHost {
  readonly store: { triggers: { get(id: string): Trigger | undefined } }
}

/** The lead this ticket started on. Throws when the ticket is not an Odoo `crm.lead` activity. */
export function odooLead(host: OdooToolsHost, ticket: Ticket): { resId: number; activityId: number } {
  const trigger = host.store.triggers.get(ticket.origin.triggerId)
  if (!trigger || trigger.source !== SOURCE) throw new Error('This ticket did not start on Odoo')
  const resId = trigger.meta.resId
  if (trigger.meta.model !== ODOO_MODEL || typeof resId !== 'number' || !Number.isInteger(resId) || resId <= 0) throw new Error('This ticket has no crm.lead')
  const activityId = trigger.meta.activityId
  return { resId, activityId: typeof activityId === 'number' ? activityId : 0 }
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

/**
 * The three Odoo tools, present only on a ticket that started from this Source.
 * Each call is limited to that ticket's lead and to the field whitelist.
 */
export function odooExecutorTools(host: OdooToolsHost, ticket: Ticket, rpc: () => OdooRpc = odooRpc): Tool[] {
  const trigger = host.store.triggers.get(ticket.origin.triggerId)
  if (trigger?.source !== SOURCE) return []
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

export type { WriteField }
