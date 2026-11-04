/** Normalizes a WeCom smart-bot long-connection frame into a Trigger. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'wecom'
/** Group chat ids and userids the admin console and callbacks use. Encrypted userids stay within this alphabet. */
export const WECOM_ID = /^[A-Za-z0-9_@.+/=-]{1,128}$/
const MARKS = '①②③④⑤⑥⑦⑧⑨⑩'

const FromSchema = z.looseObject({ userid: z.string().min(1) })
const MessageSchema = z.looseObject({
  msgid: z.string().min(1),
  aibotid: z.string().optional(),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']).optional(),
  from: FromSchema.optional(),
  msgtype: z.string().optional(),
  text: z.looseObject({ content: z.string() }).optional(),
  voice: z.looseObject({ content: z.string() }).optional(),
  mixed: z.looseObject({
    msg_item: z.array(z.looseObject({
      msgtype: z.string().optional(),
      text: z.looseObject({ content: z.string() }).optional(),
    })).optional(),
  }).optional(),
  create_time: z.number().optional(),
  compat_info: z.unknown().optional(),
})
const EventSchema = z.looseObject({
  msgid: z.string().min(1),
  aibotid: z.string().optional(),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']).optional(),
  from: FromSchema.optional(),
  msgtype: z.string().optional(),
  create_time: z.number().optional(),
  compat_info: z.unknown().optional(),
  event: z.looseObject({
    eventtype: z.string(),
    event_key: z.string().optional(),
    task_id: z.string().optional(),
  }),
})
type MessageBody = z.infer<typeof MessageSchema>
type EventBody = z.infer<typeof EventSchema>

/** Reply address. A direct chat's id is the user's userid; a group chat's id is the callback `chatid`. */
export const wecomChannel = (chatId: string, messageId: string, direct = false): ChannelRef => ({
  source: SOURCE,
  thread: `wecom:${direct ? `dm:${chatId}` : chatId}`,
  address: { chatId, messageId, chatType: direct ? 'single' : 'group' },
})
/** Deterministic trigger id for one callback `msgid`. */
export const wecomTriggerId = (messageId: string): string => key(SOURCE, messageId)
/**
 * Message callbacks omit `create_time`. Events send Unix seconds. A missing or unreadable time is the receive time,
 * which is stable for a stored trigger because a repeated `msgid` is a duplicate.
 */
export function wecomTime(value: number | undefined, now: string): string {
  if (value === undefined || !Number.isFinite(value)) return now
  const ms = value < 1e12 ? value * 1000 : value
  const date = new Date(ms)
  return Number.isFinite(date.getTime()) ? date.toISOString() : now
}

function frameBody(input: unknown): Record<string, unknown> | undefined {
  if (!input || typeof input !== 'object') return undefined
  const record = input as Record<string, unknown>
  const body = record.body
  return body && typeof body === 'object' ? body as Record<string, unknown> : record
}
function place(body: { chatid?: string | undefined; chattype?: 'single' | 'group' | undefined; from?: { userid: string } | undefined }):
  { direct: boolean; chatId: string } | undefined {
  const userid = body.from?.userid
  if (!userid) return undefined
  if (body.chattype === 'single' || (body.chattype !== 'group' && !body.chatid)) return { direct: true, chatId: userid }
  if (!body.chatid) return undefined
  return { direct: false, chatId: body.chatid }
}
function admit(body: MessageBody | EventBody, text: string, now: string, extra: Record<string, unknown> = {}): Trigger | undefined {
  if (body.compat_info !== undefined) return undefined
  const userid = body.from?.userid
  if (!userid || (body.aibotid !== undefined && userid === body.aibotid)) return undefined
  const where = place(body)
  const trimmed = text.trim()
  if (!where || !trimmed) return undefined
  const direct = where.direct
  return {
    id: wecomTriggerId(body.msgid), source: SOURCE, threads: [{ source: SOURCE, id: direct ? `dm:${where.chatId}` : where.chatId }],
    actor: { source: SOURCE, id: userid }, human: true, addressed: direct ? 'direct' : 'mention',
    at: wecomTime(body.create_time, now), text: trimmed,
    channel: wecomChannel(where.chatId, body.msgid, direct),
    meta: { chatId: where.chatId, chatType: direct ? 'single' : 'group', messageId: body.msgid, direct, mentioned: !direct, userid, ...extra },
  }
}
function messageText(body: MessageBody): string | undefined {
  if (body.msgtype === 'voice') return body.voice?.content
  if (body.msgtype === 'mixed') {
    const parts = (body.mixed?.msg_item ?? []).flatMap(item => item.msgtype === 'text' && item.text?.content ? [item.text.content] : [])
    return parts.join('\n')
  }
  if (body.msgtype === undefined || body.msgtype === 'text') return body.text?.content
  return undefined
}

/**
 * A text, voice transcript, mixed-text, or template-card click. Image-only messages, session-enter events, and
 * non-user callbacks (`compat_info`) are not triggers. The long connection has no history to recover them later.
 */
export function wecomTrigger(input: unknown, now = new Date().toISOString()): Trigger | undefined {
  const body = frameBody(input)
  if (!body) return undefined
  if (body.msgtype === 'event' || (body.event && typeof body.event === 'object')) {
    const event = EventSchema.safeParse(body)
    if (!event.success || event.data.event.eventtype !== 'template_card_event') return undefined
    const keyText = event.data.event.event_key
    if (!keyText) return undefined
    return admit(event.data, keyText, now, {
      ...(event.data.event.event_key ? { eventKey: event.data.event.event_key } : {}),
      ...(event.data.event.task_id ? { taskId: event.data.event.task_id } : {}),
    })
  }
  const message = MessageSchema.safeParse(body)
  if (!message.success) return undefined
  const text = messageText(message.data)
  return text === undefined ? undefined : admit(message.data, text, now)
}

/** Lines such as `① 合并` in a gate report. Fewer than two is not a choice card. */
export function gateOptions(text: string): { mark: string; label: string }[] {
  return text.split('\n').flatMap(raw => {
    const match = new RegExp(`^([${MARKS}])\\s+(\\S.*)$`).exec(raw.trim())
    return match?.[1] && match[2] ? [{ mark: match[1], label: match[2].trim() }] : []
  })
}
