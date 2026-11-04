/** Normalizes a WeCom smart-bot long-connection frame into a Trigger. */
import { z } from 'zod'
import { key, type ChannelRef, type Trigger } from '../core/index.ts'

export const SOURCE = 'wecom'
/** Group chat ids and userids the admin console and callbacks use. Encrypted userids stay within this alphabet. */
export const WECOM_ID = /^[A-Za-z0-9_@.+/=-]{1,128}$/
const MARKS = '①②③④⑤⑥⑦⑧⑨⑩'
/** How many pictures from one callback are kept. The rest are named, not downloaded. */
export const WECOM_IMAGE_MAX = 4
export const WECOM_IMAGE_MISSED = '（这张图片没有取到）'
export const WECOM_FILE_MISSED = '（这个文件没有取到）'
export const WECOM_IMAGE_EXTRA = '（还有图片没带上）'
export const WECOM_FILE_NOTE = '[文件]'
export const WECOM_QUOTE = '引用：'
const IMAGE_KEY = /^wximg_[1-9]\d*$/

const MediaSchema = z.looseObject({
  url: z.string().optional(),
  aeskey: z.string().optional(),
})
const ItemSchema = z.looseObject({
  msgtype: z.string().optional(),
  text: z.looseObject({ content: z.string() }).optional(),
  image: MediaSchema.optional(),
})
const PieceSchema = z.looseObject({
  msgtype: z.string().optional(),
  text: z.looseObject({ content: z.string() }).optional(),
  voice: z.looseObject({ content: z.string() }).optional(),
  image: MediaSchema.optional(),
  file: MediaSchema.optional(),
  mixed: z.looseObject({ msg_item: z.array(ItemSchema).optional() }).optional(),
})
const FromSchema = z.looseObject({ userid: z.string().min(1) })
const MessageSchema = PieceSchema.extend({
  msgid: z.string().min(1),
  aibotid: z.string().optional(),
  chatid: z.string().optional(),
  chattype: z.enum(['single', 'group']).optional(),
  from: FromSchema.optional(),
  create_time: z.number().optional(),
  compat_info: z.unknown().optional(),
  quote: PieceSchema.optional(),
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
type Piece = z.infer<typeof PieceSchema>
type Media = z.infer<typeof MediaSchema>
export interface WecomPendingMedia { key: string; url: string; aeskey?: string; kind: 'image' | 'file' }

/** The picture token in a trigger's text. The download address stays out of that text. */
export const wecomImageMarker = (imageKey: string): string => `[图片 ${imageKey}]`
export const wecomFileMarker = (imageKey: string): string => `[文件 ${imageKey}]`
/** Picture tokens in message text. A key that was not written into the text is not readable. */
export function wecomImageKeys(text: string): string[] {
  return [...new Set(text.match(/\bwximg_[1-9]\d*\b/g) ?? [])]
}

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
function marker(kind: WecomPendingMedia['kind'], imageKey: string): string {
  switch (kind) {
    case 'image': return wecomImageMarker(imageKey)
    case 'file': return wecomFileMarker(imageKey)
    default: {
      const unreachable: never = kind
      return unreachable
    }
  }
}
interface Speech { lines: string[]; pending: WecomPendingMedia[]; dropped: boolean }
function pushMedia(speech: Speech, kind: WecomPendingMedia['kind'], media: Media | undefined): void {
  const url = media?.url?.trim()
  if (!url) return
  if (speech.pending.length >= WECOM_IMAGE_MAX) {
    if (!speech.dropped) speech.lines.push(WECOM_IMAGE_EXTRA)
    speech.dropped = true
    return
  }
  const imageKey = `wximg_${speech.pending.length + 1}`
  if (!IMAGE_KEY.test(imageKey)) return
  const aeskey = media?.aeskey?.trim()
  speech.pending.push({ key: imageKey, url, kind, ...(aeskey ? { aeskey } : {}) })
  speech.lines.push(marker(kind, imageKey))
}
function pushText(speech: Speech, content: string | undefined): void {
  const trimmed = content?.trim()
  if (trimmed) speech.lines.push(trimmed)
}
/** Caption, quote, and picture tokens in callback order. The url and aes key never enter the text. */
function appendPiece(speech: Speech, piece: Piece): void {
  const type = piece.msgtype
  if (type === 'voice') { pushText(speech, piece.voice?.content); return }
  if (type === 'image') { pushMedia(speech, 'image', piece.image); return }
  if (type === 'file') { pushMedia(speech, 'file', piece.file); return }
  if (type === 'mixed') {
    for (const item of piece.mixed?.msg_item ?? []) {
      if (item.msgtype === 'image') pushMedia(speech, 'image', item.image)
      else if (item.msgtype === undefined || item.msgtype === 'text') pushText(speech, item.text?.content)
    }
    return
  }
  if (type === undefined || type === 'text') pushText(speech, piece.text?.content)
}
function appendQuote(speech: Speech, quote: Piece): void {
  const inner: Speech = { lines: [], pending: speech.pending, dropped: speech.dropped }
  appendPiece(inner, quote)
  speech.dropped = inner.dropped
  if (!inner.lines.length) return
  const [only] = inner.lines
  if (inner.lines.length === 1 && only && !only.startsWith('[')) speech.lines.push(`${WECOM_QUOTE}${only}`)
  else speech.lines.push(WECOM_QUOTE, ...inner.lines)
}
function spoken(body: MessageBody): { text: string; pending: WecomPendingMedia[] } | undefined {
  const speech: Speech = { lines: [], pending: [], dropped: false }
  if (body.quote) appendQuote(speech, body.quote)
  appendPiece(speech, body)
  const text = speech.lines.join('\n').trim()
  if (!text) return undefined
  return { text, pending: speech.pending }
}

/**
 * A text, voice transcript, picture, file, mixed message, or template-card click.
 * Picture bytes are not on the frame: `meta.pendingMedia` holds the url and aes key until the socket downloads them.
 * Session-enter events and non-user callbacks (`compat_info`) are not triggers.
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
  const parts = spoken(message.data)
  if (!parts) return undefined
  return admit(message.data, parts.text, now, parts.pending.length ? { pendingMedia: parts.pending } : {})
}

/** Lines such as `① 合并` in a gate report. Fewer than two is not a choice card. */
export function gateOptions(text: string): { mark: string; label: string }[] {
  return text.split('\n').flatMap(raw => {
    const match = new RegExp(`^([${MARKS}])\\s+(\\S.*)$`).exec(raw.trim())
    return match?.[1] && match[2] ? [{ mark: match[1], label: match[2].trim() }] : []
  })
}
