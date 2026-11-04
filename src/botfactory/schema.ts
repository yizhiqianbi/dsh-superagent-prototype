/** A role for a new WeCom bot the operator creates, and the DM-only BotFather route that writes that role. */
import { z } from 'zod'
import { WRITE_FIELDS } from '../sources/odoo-trigger.ts'
import { WECOM_ID } from '../sources/wecom-trigger.ts'

/** Words that do not belong in speech a person hears. */
export const PLAIN_SPEECH = /闸门|呈报|WECOM_BOT_SECRET|\bBotID\b|\bsecret\b/i
const plain = (value: string) => !PLAIN_SPEECH.test(value)
const LineSchema = z.string().trim().min(1).max(80).refine(plain, 'Use plain speech')
const WriteSurfaceSchema = z.string().trim().min(1).max(80).refine(value => {
  if (!/^[a-z][a-z0-9_]*$/.test(value)) return plain(value)
  return (WRITE_FIELDS as readonly string[]).includes(value)
}, 'An Odoo field name here must be one the lead writer already allows')

export const GroupSchema = z.object({
  chatId: z.string().regex(WECOM_ID),
  name: z.string().trim().min(1).max(60).optional(),
  /**
   * Feishu listed chats only. `all` receives messages that do not @ the bot.
   * Omitted means mentions. A WeCom chat must omit this: that connection only delivers group messages that @ the bot.
   */
  listen: z.enum(['mentions', 'all']).optional(),
}).strict()
/** Feishu chat ids in this host. Anything else in `groups` is a WeCom chat for the new bot, once the operator hangs the role. */
export const FEISHU_CHAT = /^oc_[a-zA-Z0-9]+$/
export const FEISHU_OPEN_ID = /^ou_[a-zA-Z0-9]+$/
export const chatChannel = (chatId: string): 'feishu' | 'wecom' => FEISHU_CHAT.test(chatId) ? 'feishu' : 'wecom'
/**
 * `otherChats` is the Source chat policy, and a new role defaults to `mentions`.
 * `mentions` registers the named chats and also takes @ mentions in every other connected group.
 * `none` is the opt-out: only `groups`.
 * WeCom has no value that hears a group without an @. `listen: all` is only for a Feishu `oc_` chat.
 * Recording this does not flip the Source switch.
 */
export const ScopeSchema = z.object({
  directMessages: z.boolean(),
  otherChats: z.enum(['none', 'mentions']).default('mentions'),
  groups: z.array(GroupSchema).max(40),
}).strict().refine(scope => scope.directMessages || scope.groups.length > 0 || scope.otherChats === 'mentions', 'Name a direct chat, a group, or every connected group')
  .refine(scope => new Set(scope.groups.map(group => group.chatId)).size === scope.groups.length, 'Duplicate chat IDs')
  .refine(scope => scope.groups.every(group => group.listen === undefined || FEISHU_CHAT.test(group.chatId)), 'listen is only for a Feishu oc_ chat. WeCom groups arrive only when the bot is @ mentioned')
export const EscalationSchema = z.object({
  name: z.string().trim().min(1).max(40).refine(plain, 'Use plain speech'),
  wecomUserId: z.string().regex(WECOM_ID).optional(),
  feishuOpenId: z.string().regex(FEISHU_OPEN_ID).optional(),
}).strict()
const ErpOffSchema = z.object({ enabled: z.literal(false) }).strict()
const ErpOnSchema = z.object({
  enabled: z.literal(true),
  adapter: z.literal('odoo'),
  sourceOfTruth: z.string().trim().min(1).max(120),
  read: z.array(LineSchema).min(1).max(20),
  write: z.array(WriteSurfaceSchema).min(1).max(20),
}).strict()

/**
 * A role the operator hangs on a new WeCom bot. `permissions` stays `deferred`: this file does not grant an allow-list, and it does not store a BotID or a Secret.
 * `id` is the template id. `name` is what people call the role. A group is Feishu when its chat id starts with `oc_`, and WeCom otherwise.
 */
export const BusinessIdentitySchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,40}$/).refine(id => id !== 'botfather', 'botfather is the factory route, not a business line'),
  name: z.string().trim().min(1).max(40).refine(plain, 'Use plain speech'),
  persona: z.string().trim().min(1).max(200).refine(plain, 'Use plain speech'),
  scope: ScopeSchema,
  autoReply: z.array(LineSchema).min(1).max(20),
  autoAdvance: z.array(LineSchema).min(1).max(20),
  humanApprove: z.array(LineSchema).min(1).max(20),
  formatter: z.string().trim().min(1).max(60).refine(plain, 'Use plain speech'),
  escalation: z.array(EscalationSchema).min(1).max(10),
  erp: z.discriminatedUnion('enabled', [ErpOffSchema, ErpOnSchema]),
  smoke: z.string().trim().min(1).max(160).refine(plain, 'Use plain speech'),
  permissions: z.literal('deferred').default('deferred'),
}).strict()
export type BusinessIdentity = z.infer<typeof BusinessIdentitySchema>
export type ErpConfig = BusinessIdentity['erp']

/** BotFather is a direct-message route used to write a role. `operators` empty means any DM that shows factory intent. An operator id may be a WeCom userid or a Feishu open_id. The route is not a BotID. */
export const BotfatherRouteSchema = z.object({
  id: z.literal('botfather'),
  name: z.string().trim().min(1).max(40).default('BotFather'),
  route: z.literal('dm'),
  operators: z.array(z.string().regex(WECOM_ID)).max(40).default([]),
}).strict()
export type BotfatherRoute = z.infer<typeof BotfatherRouteSchema>
export const DEFAULT_ROUTE: BotfatherRoute = { id: 'botfather', name: 'BotFather', route: 'dm', operators: [] }

const FactoryLineSchema = z.object({
  role: z.enum(['user', 'assistant']),
  text: z.string().min(1).max(2000),
}).strict()
/** An open BotFather conversation. The session asks and decides; this only remembers the talk. */
export const FactoryDraftSchema = z.object({
  open: z.literal(true),
  lines: z.array(FactoryLineSchema).max(40).default([]),
}).strict()
export type FactoryDraft = z.infer<typeof FactoryDraftSchema>
