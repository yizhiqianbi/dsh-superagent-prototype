/** WeCom outbound frames: markdown, or a button card when a short gate report has numbered options. */
import { key, type OutboundMessage, type Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { SourceContext } from './host.ts'
import type { ChannelLink } from './kind.ts'
import { currentWecomSend } from './wecom-socket.ts'
import { SOURCE, gateOptions, wecomTriggerId } from './wecom-trigger.ts'

/** A greeting and nothing else. Anything with a request stays on the ordinary received line. */
const GREETING = /^(?:你好|您好|嗨|hi|hello|hey|在吗|在么|早上好|下午好|晚上好)[!！。.~～\s]*$/i
export const WECOM_GREETING = '在的。跟单、催办、到账确认这类事直接说就行。'
export const WECOM_RECEIVED = '收到。具体要办的事（客户/订单/节点）说一下，我帮你盯着推进；需要你拍板的我会先把选项列好。'

/** One short companion line. It does not name a customer, an order, or a decision. A saved role does not replace it. */
export function wecomCompanionText(text: string): string {
  if (!GREETING.test(text.trim())) return WECOM_RECEIVED
  return WECOM_GREETING
}

/**
 * The companion notice for one trigger. Its id is the trigger id, so a repeated msgid and an Outbox retry stay one message.
 * It is not the ticket acknowledgement (`ack`), which Eval may queue later for real work.
 */
export function wecomCompanionNotice(trigger: Trigger, text = wecomCompanionText(trigger.text)): OutboundMessage | undefined {
  if (trigger.source !== SOURCE || !trigger.channel) return undefined
  return { id: key('wecom-notice', trigger.id), channel: trigger.channel, text, kind: 'notice' }
}

/** Title, detail and button lengths WeCom's button card actually displays. Longer reports stay markdown. */
const TITLE_MAX = 26
const DETAIL_MAX = 112
const BUTTON_MAX = 20
const KEY_MAX = 1024

export interface WecomMarkdown {
  chat_type: 1 | 2
  msgtype: 'markdown'
  markdown: { content: string }
}
export interface WecomButton { text: string; style: 1; key: string }
export interface WecomCard {
  chat_type: 1 | 2
  msgtype: 'template_card'
  template_card: {
    card_type: 'button_interaction'
    main_title: { title: string; desc?: string }
    button_list: WecomButton[]
    task_id: string
  }
}
export type WecomOutbound = WecomMarkdown | WecomCard

/** `task_id` may only contain letters, digits and `_@-`, and must be unique for the bot. */
export function wecomTaskId(messageId: string): string {
  const cleaned = messageId.replace(/[^A-Za-z0-9_@-]/g, '')
  return (cleaned.length > 0 ? cleaned : 'gate').slice(0, 128)
}

function gateCard(text: string, messageId: string): WecomCard['template_card'] | undefined {
  const options = gateOptions(text)
  if (options.length < 2) return undefined
  const prose = text.split('\n').map(line => line.trim()).filter(line => line && !gateOptions(line).length)
  const title = prose[0] ?? '待确认'
  const detail = prose.slice(1).join('\n')
  if ([...title].length > TITLE_MAX || [...detail].length > DETAIL_MAX) return undefined
  const buttons = options.map((option): WecomButton | undefined => {
    const key = `${option.mark} ${option.label}`
    if ([...key].length > BUTTON_MAX || Buffer.byteLength(key) > KEY_MAX) return undefined
    return { text: key, style: 1, key }
  })
  if (buttons.some(button => !button)) return undefined
  return {
    card_type: 'button_interaction',
    main_title: { title, ...(detail ? { desc: detail } : {}) },
    button_list: buttons.filter((button): button is WecomButton => !!button),
    task_id: wecomTaskId(messageId),
  }
}

/**
 * One proactive `aibot_send_msg` body. `chat_type` is set explicitly: the SDK's `sendMessage` omits it, and WeCom
 * otherwise tries the chat id as a group first. A gate report becomes a button card only when every line fits.
 */
export function wecomOutbound(text: string, chatType: 'single' | 'group', messageId: string): WecomOutbound {
  const chat_type = chatType === 'single' ? 1 : 2
  const template_card = gateCard(text, messageId)
  return template_card ? { chat_type, msgtype: 'template_card', template_card } : { chat_type, msgtype: 'markdown', markdown: { content: text } }
}

/** A permanent refusal to deliver. Anything else, including a dropped socket, is retried by the outbox. */
export function wecomGone(error: unknown): boolean {
  const errmsg = error && typeof error === 'object' && 'errmsg' in error
    ? String((error as { errmsg: unknown }).errmsg)
    : error instanceof Error ? error.message : String(error)
  return /not exist|not found|invalid chat|chatid invalid|无权限|会话不存在|不在会话/i.test(errmsg)
}

/** Pushes markdown, or a gate card, on the one open long connection. A lost ack can deliver twice: WeCom keys the ack by its own req_id. */
export async function sendWecom(_host: Pick<SourceContext, 'commands'>, message: OutboundMessage): Promise<'sent' | 'gone'> {
  const chatId = message.channel.address.chatId
  if (!chatId) throw new Error('Missing WeCom chat')
  const send = currentWecomSend()
  if (!send) throw new Error('WeCom long connection is not ready')
  const chatType = message.channel.address.chatType === 'single' || message.channel.address.direct === 'true' ? 'single' : 'group'
  try {
    await send(chatId, wecomOutbound(checkedImText(message.text), chatType, message.id))
    return 'sent'
  } catch (error) {
    if (wecomGone(error)) return 'gone'
    throw error
  }
}

/** WeCom gives this callback no message URL. The panel still names the channel. */
export function wecomLink(address: Record<string, string>): ChannelLink {
  return {
    url: '', label: { zh: '企业微信消息', en: 'WeCom message' },
    ...address.messageId ? { triggerId: wecomTriggerId(address.messageId) } : {},
  }
}
