/** Odoo channel: an internal note on the related record, posted once per outgoing message id. */
import type { OutboundMessage } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink, Localized } from './kind.ts'
import { odooRecordGone, odooRpc, type OdooRpc } from './odoo-rpc.ts'
import { isRecordModel, recordUrl } from './odoo-trigger.ts'

/** Token stored in the note body so a retried send finds the note instead of posting it again. */
export const odooMarker = (messageId: string): string => `dsh-superagent:${messageId}`

function escapeHtml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Note HTML. A marker, when present, is a paragraph the sanitizer keeps, so a later search can see it. */
export function noteHtml(text: string, marker?: string): string {
  const body = `<p>${escapeHtml(text).replace(/\n/g, '<br>')}</p>`
  return marker ? `${body}<p>${escapeHtml(marker)}</p>` : body
}

/**
 * Post `body` on the record once. A note whose body already contains `marker` counts as sent.
 * A deleted record is `gone`; every other failure throws so the outbox retries.
 */
export async function postOdooNote(rpc: OdooRpc, model: string, resId: number, text: string, marker: string | undefined, signal?: AbortSignal): Promise<'sent' | 'gone'> {
  try {
    if (marker) {
      const existing = await rpc.searchRead('mail.message', [['model', '=', model], ['res_id', '=', resId], ['body', 'ilike', marker]],
        { fields: ['id'], limit: 1 }, signal)
      if (existing.length) return 'sent'
    }
    await rpc.messagePost(model, resId, noteHtml(text, marker), signal)
    return 'sent'
  } catch (error) {
    if (odooRecordGone(error)) return 'gone'
    throw error
  }
}

function linkLabel(model: string, id: string): Localized {
  switch (model) {
    case 'mrp.production': return { zh: `Odoo 制造订单 ${id}`, en: `Odoo manufacturing order ${id}` }
    case 'sale.order': return { zh: `Odoo 销售订单 ${id}`, en: `Odoo sales order ${id}` }
    case 'crm.lead': return { zh: `Odoo 线索 ${id}`, en: `Odoo lead ${id}` }
    default: return { zh: `Odoo ${id}`, en: `Odoo ${id}` }
  }
}

/** Reply on the record the address names. The message id is the idempotency key. */
export async function sendOdoo(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const model = message.channel.address.model ?? ''
  const resId = Number(message.channel.address.res_id)
  if (!isRecordModel(model) || !Number.isInteger(resId) || resId <= 0) throw new Error('Missing Odoo reply target')
  return postOdooNote(odooRpc(), model, resId, checkedImText(message.text), odooMarker(message.id))
}

/** The record's form. The base URL is the process environment, the same default the client uses. */
export function odooLink(address: Record<string, string>): ChannelLink {
  const resId = Number(address.res_id)
  const model = address.model ?? ''
  const url = isRecordModel(model) && Number.isInteger(resId) && resId > 0
    ? recordUrl(process.env.ODOO_URL?.trim() || 'http://127.0.0.1:8069', model, resId) : ''
  return { url, label: linkLabel(model, address.res_id ?? '') }
}
