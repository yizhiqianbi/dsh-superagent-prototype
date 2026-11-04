/** One business line on the single WeCom bot, and the DM-only BotFather route that creates lines. */
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
  /** Feishu listed chats. Omitted on a WeCom chat. `oc_` ids default to mentions when this is absent. */
  listen: z.enum(['mentions', 'all']).optional(),
}).strict()
/** Feishu chat ids in this host. Anything else in `groups` is a WeCom chat on the one bot. */
export const FEISHU_CHAT = /^oc_[a-zA-Z0-9]+$/
export const FEISHU_OPEN_ID = /^ou_[a-zA-Z0-9]+$/
export const chatChannel = (chatId: string): 'feishu' | 'wecom' => FEISHU_CHAT.test(chatId) ? 'feishu' : 'wecom'
/**
 * `otherChats` is the Source chat policy: `mentions` means every connected group,
 * `none` means only `groups`. Recording it here does not flip the Source switch.
 */
export const ScopeSchema = z.object({
  directMessages: z.boolean(),
  otherChats: z.enum(['none', 'mentions']).default('none'),
  groups: z.array(GroupSchema).max(40),
}).strict().refine(scope => scope.directMessages || scope.groups.length > 0 || scope.otherChats === 'mentions', 'Name a direct chat, a group, or every connected group')
  .refine(scope => new Set(scope.groups.map(group => group.chatId)).size === scope.groups.length, 'Duplicate chat IDs')
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
 * A business line on the WeCom bot and the Feishu bot together. `permissions` stays `deferred`: this file does not grant an allow-list.
 * `id` is the template id. `name` is what people call the line. A group is Feishu when its chat id starts with `oc_`, and WeCom otherwise.
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

/** BotFather is a direct-message route on the existing WeCom bot and the existing Feishu bot. `operators` empty means any DM that shows factory intent. An operator id may be a WeCom userid or a Feishu open_id. */
export const BotfatherRouteSchema = z.object({
  id: z.literal('botfather'),
  name: z.string().trim().min(1).max(40).default('BotFather'),
  route: z.literal('dm'),
  operators: z.array(z.string().regex(WECOM_ID)).max(40).default([]),
}).strict()
export type BotfatherRoute = z.infer<typeof BotfatherRouteSchema>
export const DEFAULT_ROUTE: BotfatherRoute = { id: 'botfather', name: 'BotFather', route: 'dm', operators: [] }

export const GRILL_SLOTS = ['name', 'persona', 'scope', 'autoReply', 'autoAdvance', 'humanApprove', 'formatter', 'escalation', 'erp', 'smoke', 'confirm'] as const
export type GrillSlot = typeof GRILL_SLOTS[number]
export const GrillDraftSchema = z.object({
  slot: z.enum(GRILL_SLOTS),
  id: z.string().optional(),
  name: z.string().optional(),
  persona: z.string().optional(),
  directMessages: z.boolean().optional(),
  otherChats: z.enum(['none', 'mentions']).optional(),
  groups: z.array(GroupSchema).optional(),
  /** Which of the two follow-ups was last used. A miss alternates; it never repeats the question. */
  asks: z.union([z.literal(0), z.literal(1)]).optional(),
  /** Set when the operator chose “named groups” but has not sent a chat id yet. */
  listenFor: z.enum(['group-id']).optional(),
  autoReply: z.array(z.string()).optional(),
  autoAdvance: z.array(z.string()).optional(),
  humanApprove: z.array(z.string()).optional(),
  formatter: z.string().optional(),
  escalation: z.array(EscalationSchema).optional(),
  erp: z.discriminatedUnion('enabled', [ErpOffSchema, ErpOnSchema]).optional(),
  smoke: z.string().optional(),
}).strict()
export type GrillDraft = z.infer<typeof GrillDraftSchema>
