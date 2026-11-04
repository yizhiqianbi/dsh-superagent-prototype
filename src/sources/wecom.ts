/** WeCom smart-bot source: long connection, settings, and the Cordis plugin entry. */
import type { Context } from '@deepseek-ai/cordis'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { sendWecom, wecomLink } from './wecom-channel.ts'
import { wecomThreadContext } from './wecom-read.ts'
import { acquireWecomBot, bindWecomSend, createWecomSocket, wecomAuthFailed, type WecomCredentials, type WecomSocket } from './wecom-socket.ts'
import { SOURCE, WECOM_ID, wecomTrigger } from './wecom-trigger.ts'

export { SOURCE, wecomTrigger, wecomTriggerId } from './wecom-trigger.ts'

/** What the operator must set. The secret itself is never stored in settings. */
export const WECOM_CREDENTIALS = 'Set the WeCom bot id (botId or WECOM_BOT_ID) and the long-connection secret in the environment variable named by secretEnv (default WECOM_BOT_SECRET). In the WeCom admin console, API mode must be 长连接.'
const ENV_NAME = /^[A-Z][A-Z0-9_]{0,63}$/
const ChatSchema = z.object({
  chatId: z.string().regex(WECOM_ID),
  name: z.string().trim().max(60).optional(),
}).strict()
const WecomConfigSchema = z.object({
  botId: z.string().trim().refine(value => value === '' || WECOM_ID.test(value), 'Invalid BotID').default(''),
  secretEnv: z.string().trim().regex(ENV_NAME).default('WECOM_BOT_SECRET'),
  chats: z.array(ChatSchema).refine(chats => new Set(chats.map(chat => chat.chatId)).size === chats.length, 'Duplicate chat IDs').default([]),
  directMessages: z.boolean().default(true),
  otherChats: z.enum(['none', 'mentions']).default('none'),
}).strict()
export type WecomConfig = z.infer<typeof WecomConfigSchema>

/** Bot id from settings or `WECOM_BOT_ID`, and the secret from the named environment variable. */
export function wecomCredentials(config: WecomConfig, env: NodeJS.ProcessEnv = process.env): WecomCredentials | undefined {
  const botId = config.botId || env.WECOM_BOT_ID?.trim() || ''
  const secret = env[config.secretEnv]?.trim() ?? ''
  if (!WECOM_ID.test(botId) || !secret) return undefined
  return { botId, secret }
}
/** Wait before opening the socket again: 1s after a session that lasted a minute, otherwise exponential up to 60s. */
export const wecomRetry = (previous: number | undefined, ranMs: number): number =>
  previous === undefined || ranMs >= 60_000 ? 1000 : Math.min(previous * 2, 60_000)

export const wecomKind: SourceKind<WecomConfig> = {
  kind: SOURCE,
  title: { zh: '企业微信', en: 'WeCom' },
  description: {
    zh: '通过智能机器人长连接接收已列出的群里 @ 机器人的消息、私聊，以及闸门卡片上的按钮。企业微信不推送群里的其他消息，也没有历史接口。BotID 写在这里或 WECOM_BOT_ID；Secret 只放在 secretEnv 指向的环境变量里。',
    en: 'Receives @ mentions in the listed chats, direct messages, and gate-card button clicks over the smart-bot long connection. WeCom does not push other group messages and has no history API. The BotID is set here or in WECOM_BOT_ID; the Secret stays in the environment variable named by secretEnv.',
  },
  schema: WecomConfigSchema,
  fields: [
    { key: 'botId', type: 'text', pattern: '[A-Za-z0-9_@.+/=-]{0,128}', label: { zh: 'BotID', en: 'BotID' },
      hint: { zh: '智能机器人的 BotID。留空则用环境变量 WECOM_BOT_ID。Secret 不写在这里。', en: 'The smart bot\'s BotID. Empty uses WECOM_BOT_ID. The Secret is not stored here.' } },
    { key: 'secretEnv', type: 'text', pattern: '[A-Z][A-Z0-9_]{0,63}', label: { zh: 'Secret 的环境变量', en: 'Secret environment variable' },
      hint: { zh: '存放长连接 Secret 的环境变量名，默认 WECOM_BOT_SECRET。在管理后台把 API 模式设为「长连接」。不要把 Secret 写进设置。', en: 'Name of the environment variable holding the long-connection Secret, WECOM_BOT_SECRET by default. Set API mode to long connection in the admin console. Do not put the Secret in settings.' } },
    { key: 'chats', type: 'rows', label: { zh: '接收的群', en: 'Chats' },
      hint: { zh: '企业微信只推送群里 @ 机器人的消息。未列出的群看下面的「其他群」。', en: 'WeCom only pushes group messages that mention the bot. Chats not listed here follow Other chats below.' },
      columns: [
        { key: 'chatId', type: 'text', label: { zh: '群 chatid', en: 'Chat id' }, pattern: '[A-Za-z0-9_@.+/=-]{1,128}' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ] },
    { key: 'otherChats', type: 'select', label: { zh: '其他群', en: 'Other chats' },
      options: [{ value: 'none', label: { zh: '不接收', en: 'Not received' } }, { value: 'mentions', label: { zh: '接收 @', en: 'Mentions' } }],
      hint: { zh: '没有列在上面的群。企业微信本来就只推送 @ 机器人的消息。', en: 'Chats that are not listed above. WeCom already pushes only messages that mention the bot.' } },
    { key: 'directMessages', type: 'switch', label: { zh: '接收私聊', en: 'Direct messages' } },
  ],
  health: ['wecom'],
  scope({ meta }, config) {
    if (meta.direct === true) return config.directMessages ? { listened: true, observed: false, row: 'direct' } : { listened: false, reason: 'direct_messages_not_allowed' }
    const chatId = String(meta.chatId ?? '')
    const chat = config.chats.find(item => item.chatId === chatId)
    if (chat) return { listened: true, observed: false, row: chat.chatId }
    return config.otherChats === 'mentions' ? { listened: true, observed: false, row: 'other' } : { listened: false, reason: 'chat_not_allowed' }
  },
  channel: {
    allowed: (address, config) => wecomKind.scope!({ meta: { chatId: address.chatId ?? '', direct: address.chatType === 'single' || address.direct === 'true' } }, config).listened,
    send: sendWecom, link: wecomLink,
  },
  threadContext: wecomThreadContext,
  policy: {
    unnamed: { person: { zh: '企业微信用户', en: 'WeCom user' }, bot: { zh: '企业微信机器人', en: 'WeCom bot' } },
    schema: z.object({
      allowed: z.array(z.object({ id: z.string().regex(WECOM_ID), name: z.string().trim().max(100).optional() }).strict())
        .refine(users => new Set(users.map(user => user.id)).size === users.length, 'Duplicate userids').default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的企业微信用户', en: 'WeCom users who may originate work' },
      columns: [
        { key: 'id', type: 'text', label: { zh: 'userid', en: 'userid' }, pattern: '[A-Za-z0-9_@.+/=-]{1,128}' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ] }],
    explicit: { zh: '名单内的人在接收的群里 @ 机器人，或私聊机器人，或点闸门卡片上的按钮。', en: 'Someone on the list mentions the bot in a received chat, messages it directly, or clicks a gate card.' },
    rows(stored) {
      const config = WecomConfigSchema.parse(stored)
      const mentions = { zh: '仅 @', en: '@ only' }
      return [
        ...config.chats.map(chat => ({ id: chat.chatId, label: chat.name || chat.chatId, note: mentions,
          cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } })),
        { id: 'other', label: { zh: '其他群', en: 'Other chats' }, note: config.otherChats === 'mentions' ? mentions : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.otherChats === 'mentions', unlistedUnaddressed: false } },
        { id: 'direct', label: { zh: '私聊', en: 'Direct messages' }, note: config.directMessages ? { zh: '接收', en: 'Received' } : { zh: '不接收', en: 'Not received' },
          cells: { listedUnaddressed: false, unlistedAddressed: config.directMessages, unlistedUnaddressed: false } },
      ]
    },
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_WECOM_BOT', description: { zh: '企业微信机器人的 BotID；未配置时为空', en: 'WeCom bot BotID; empty when it is not configured' } },
      { key: 'DSH_SUPERAGENT_WECOM_CHAT', description: { zh: '接下工单的企业微信会话；工单不是从企业微信来的时为空', en: 'WeCom chat that started the ticket; empty when the ticket did not start on WeCom' } },
    ],
    values: ({ config, trigger }) => ({
      DSH_SUPERAGENT_WECOM_BOT: config.botId,
      DSH_SUPERAGENT_WECOM_CHAT: trigger?.source === SOURCE ? String(trigger.meta.chatId ?? '') : '',
    }),
  },
}

export const name = 'dsh-superagent-wecom'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(wecomKind), 'wecom: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, wecomKind)
    const controller = new AbortController()
    const running = watchWecom(source, controller.signal)
      .catch((error: unknown) => { source.report('wecom', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

const enabled = (ctx: SourceContext): WecomConfig | undefined => ctx.config<WecomConfig>(SOURCE)

/** Runs the long connection while the plugin is loaded. Disabling the Source closes the socket within five seconds. */
export async function watchWecom(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  await ctx.ready
  if (!ctx.configured()) { ctx.report('wecom', health('paused', 'setupPending')); return }
  let retry: number | undefined
  while (!signal.aborted) {
    const config = enabled(ctx)
    if (!config) {
      ctx.report('wecom', health('paused', 'sourceOff'))
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const creds = wecomCredentials(config)
    if (!creds) {
      ctx.report('wecom', { state: 'error', detail: WECOM_CREDENTIALS })
      await delay(5000, undefined, { signal }).catch(() => {})
      continue
    }
    const began = Date.now()
    try {
      await runWecomSession(ctx, creds, signal)
      retry = undefined
    } catch (error) {
      if (signal.aborted) return
      ctx.report('wecom', { state: 'error', detail: String(error) })
      retry = wecomRetry(retry, Date.now() - began)
      await delay(retry, undefined, { signal }).catch(() => {})
    }
  }
}

function still(ctx: SourceContext, creds: WecomCredentials): boolean {
  const config = enabled(ctx)
  const next = config && wecomCredentials(config)
  return !!next && next.botId === creds.botId && next.secret === creds.secret
}

function describe(ctx: SourceContext, trigger: { meta: Record<string, unknown>; threads: { source: string; id: string }[] }): void {
  const config = enabled(ctx)
  const chatId = String(trigger.meta.chatId ?? '')
  const named = config?.chats.find(chat => chat.chatId === chatId)?.name
  const direct = trigger.meta.direct === true
  const chat = direct ? { value: { zh: '私聊', en: 'Direct message' } } : { value: named || chatId }
  for (const ref of trigger.threads) ctx.threads.describe(threadKey(ref), { ...direct ? {} : { label: named || chatId }, facts: { chat } })
}

/** Holds the one socket for `creds.botId` until abort, a credential change, or an authentication failure the SDK stopped retrying. */
export async function runWecomSession(ctx: SourceContext, creds: WecomCredentials, signal: AbortSignal): Promise<void> {
  const release = acquireWecomBot(creds.botId)
  const client = createWecomSocket(creds)
  let unbind = () => {}
  const dropSend = () => { unbind(); unbind = () => {} }
  let chain = Promise.resolve()
  const ingest = (frame: unknown): void => {
    chain = chain.then(async () => {
      if (signal.aborted || !enabled(ctx)) return
      const trigger = wecomTrigger(frame)
      if (!trigger) return
      await ctx.receive(trigger)
      describe(ctx, trigger)
    }).catch((error: unknown) => { ctx.report('wecom', { state: 'error', detail: String(error) }) })
  }
  try {
    await session(ctx, client, creds, signal, ingest, {
      ready: () => { dropSend(); unbind = bindWecomSend((chatId, body) => client.sendMessage(chatId, body)) },
      drop: dropSend,
    })
  } finally {
    dropSend()
    client.disconnect()
    release()
    await chain
  }
}

function session(ctx: SourceContext, client: WecomSocket, creds: WecomCredentials, signal: AbortSignal, ingest: (frame: unknown) => void,
  send: { ready(): void; drop(): void }): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (error?: unknown) => {
      if (settled) return
      settled = true
      clearInterval(check)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error instanceof Error ? error : new Error(String(error)))
      else resolve()
    }
    const onAbort = () => finish()
    const check = setInterval(() => { if (!still(ctx, creds)) finish() }, 5000)
    signal.addEventListener('abort', onAbort, { once: true })
    client.on('authenticated', () => {
      send.ready()
      ctx.report('wecom', { state: 'ready', detail: `Long connection ready for ${creds.botId}`, at: new Date().toISOString() })
    })
    client.on('reconnecting', attempt => {
      send.drop()
      ctx.report('wecom', { state: 'error', detail: `Reconnecting to WeCom (attempt ${String(attempt)})` })
    })
    client.on('disconnected', () => { send.drop() })
    client.on('error', error => {
      if (wecomAuthFailed(error)) finish(error)
      else ctx.report('wecom', { state: 'error', detail: error instanceof Error ? error.message : String(error) })
    })
    client.on('event.disconnected_event', () => {
      finish(new Error(`WeCom closed this long connection because another connection subscribed ${creds.botId}`))
    })
    client.on('message.text', ingest)
    client.on('message.voice', ingest)
    client.on('message.mixed', ingest)
    client.on('event.template_card_event', ingest)
    if (signal.aborted) { finish(); return }
    try { client.connect() } catch (error) { finish(error) }
  })
}
