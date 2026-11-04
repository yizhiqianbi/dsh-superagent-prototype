/** BotFather's direct-message grill: one block at a time, heard answers stick, misses get a different sentence. */
import { createHash } from 'node:crypto'
import { wordCount, IM_WORDS } from '../infra/text.ts'
import { WECOM_ID } from '../sources/wecom-trigger.ts'
import { BusinessIdentitySchema, FEISHU_OPEN_ID, PLAIN_SPEECH, chatChannel, type BusinessIdentity, type ErpConfig, type GrillDraft, type GrillSlot } from './schema.ts'

const STARTS = ['新建业务线', '新业务线', '开一条线', '做一条业务线', '/botfather', '/new', 'botfather']
type AskSlot = Exclude<GrillSlot, 'confirm'>
type ScopeChoice = { directMessages: boolean; groups: { chatId: string }[]; otherChats: 'none' | 'mentions' }
const OFFERED = {
  autoReply: ['打招呼', '问进度'],
  autoAdvance: ['跟单', '催办', '到账确认'],
  humanApprove: ['改价格', '承诺交期'],
} as const
const QUESTIONS: Record<AskSlot, string> = {
  name: '这条线叫什么？例如：外贸跟单伴侣。',
  persona: '用一句话说它是谁。例如：跟单同事，口语盯客户、订单和到账。',
  scope: '它在哪说话？三选一：只私聊；私聊加指定群（wr_… 或 oc_…）；私聊加所有已接入的群。',
  autoReply: '哪些话直接回？例如：打招呼、问进度。说「就这些」我就按这个记。',
  autoAdvance: '哪些事直接往下推进？例如：跟单、催办、到账确认。说「就这些」也行。',
  humanApprove: '哪些事需要你拍板？例如：改价格、承诺交期。说「就这些」也行。',
  formatter: '谁来把选项说清楚？例如：跟单同事。说「它自己」就用这条线。',
  escalation: '权限先不做。卡住了找谁？例如：外贸负责人。说「就他」也行。',
  erp: '要接 Odoo 吗？回「不接」，或「接 Odoo」。',
  smoke: '私聊里怎么打招呼？用口语。说「你写」我就写一句在的。',
}
const NUDGES: Record<AskSlot, readonly [string, string]> = {
  name: ['起个短名就行，比如：外贸跟单伴侣。', '还差名字。两三个字也行，比如：跟单。'],
  persona: ['一句人话就行，比如：它是跟单同事。', '还没听清它是谁。比如：它是跟单同事，帮人盯订单。'],
  scope: ['选一个就行：只私聊；私聊加指定群，再发 wr_… 或 oc_…；私聊加所有已接入的群。', '还没对上。回「只私聊」，或发群号 wr_… / oc_…，或回「所有群都行」。'],
  autoReply: ['举几个就行，比如：打招呼、问进度。或者说「就这些」。', '还差直接回的话。比如打招呼、问进度，或者说「就这些」。'],
  autoAdvance: ['举几个就行，比如：跟单、催办、到账确认。或者说「就这些」。', '还差往下推进的事。比如跟单、催办，或者说「就这些」。'],
  humanApprove: ['哪些需要你拍板？比如：改价格、承诺交期。或者说「就这些」。', '还差要你拍板的事。比如改价格、承诺交期，或者说「就这些」。'],
  formatter: ['写谁来说选项，比如：跟单同事。或者说「它自己」。', '还差谁来把选项说清楚。比如跟单同事，或者说「它自己」。'],
  escalation: ['写一个名字就行，比如：外贸负责人。或者说「就他」。', '还差找谁。比如外贸负责人，或者说「就他」。'],
  erp: ['回「不接」或「接 Odoo」就行。', '二选一：不接，或者接 Odoo。'],
  smoke: ['写一句人话就行，比如：在的。或者说「你写」。', '还差招呼。用口语写一句，或者说「你写」。'],
}
const GROUP_NUDGES: readonly [string, string] = [
  '把群号发我。企业微信 wr_ 开头，飞书 oc_ 开头。也可以改口：只私聊，或所有群都行。',
  '还差群号。发 wr_… 或 oc_…。不想指定的话，回「只私聊」或「所有群都行」。',
]
const CONFIRM_NUDGES: readonly [string, string] = [
  '没对上。回复「就这样」就接上，回复「取消」作废。',
  '要接上就回「就这样」，不要了就回「取消」。',
]
export const BOTFATHER_INIT = '要开新线，先在这台机器跑 botfactory-wire --init，然后再发「新建业务线」。还是这一个机器人。'
const ROUTE_BROKEN = 'BotFather 的路由文件读不了，私聊工厂先停着。'
const SAVE_FAILED = '没存上。再发一次。'

export interface BotfatherTurn {
  handled: true
  text: string
  draft: GrillDraft | null
  wired?: BusinessIdentity
}
export type FactoryRoute = { ok: true; operators: readonly string[] } | { ok: false }

/** A factory command, and any name typed after it. Longer phrases are matched first. */
export function factoryStart(text: string): { rest: string } | undefined {
  const trimmed = text.trim()
  const folded = trimmed.toLowerCase()
  for (const phrase of STARTS) {
    const probe = phrase.startsWith('/') || phrase === 'botfather' ? folded : trimmed
    const boundary = probe[phrase.length]
    if (probe.startsWith(phrase) && (boundary === undefined || /[\s:：]/.test(boundary))) {
      return { rest: trimmed.slice(phrase.length).replace(/^[:：\s]+/, '') }
    }
  }
  return undefined
}

function spoken(text: string, fallback: string): string {
  return wordCount(text) <= IM_WORDS ? text : fallback
}

/** The id stored on disk. A Latin token is kept; a Chinese name gets a stable `line-` id. */
export function identityId(name: string): string {
  const latin = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (/^[a-z][a-z0-9-]{1,40}$/.test(latin) && latin !== 'botfather') return latin
  return `line-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

function punct(text: string): string {
  return text.trim().replace(/[。.!！？?\s]+$/g, '')
}

function emptyTalk(text: string): boolean {
  return /^(?:嗯+|啊+|哦+|呃+|啥|什么|不知道|不明白|哈+)[。.!！？?\s]*$/.test(text.trim())
}

function acceptsExamples(text: string): boolean {
  return /^(?:就这些|按这个|按例子|按你说的|你定|你看着办|看着办|都行|随便|可以|行|好的|好)$/.test(punct(text))
}

function offerWord(text: string): boolean {
  return /^(?:可以|行|好|好的|就这些|随便|嗯+|啊+)$/.test(text)
}

function tidyName(text: string): string {
  return text.trim()
    .replace(/^(?:这条线|它|他|她)?(?:名字|名称)?(?:就)?(?:叫做|叫它|叫她|叫他|叫)/, '')
    .replace(/(?:就可以了|就可以|就行了|就行|好了|吧|啊|呀|哦)$/u, '')
    .trim()
}

function parseName(text: string): { id: string; name: string } | undefined {
  const trimmed = punct(text)
  const pair = /^([a-z][a-z0-9-]{1,40})\s+(.+)$/.exec(trimmed)
  if (pair?.[1] && pair[2] && pair[1] !== 'botfather') {
    const name = tidyName(pair[2])
    if (name && name.length <= 40 && !PLAIN_SPEECH.test(name) && !offerWord(name)) return { id: pair[1], name }
  }
  const name = tidyName(trimmed)
  if (!name || name.length > 40 || name === 'botfather' || PLAIN_SPEECH.test(name) || offerWord(name)) return undefined
  return { id: identityId(name), name }
}

function parsePersona(text: string): string | undefined {
  const persona = punct(text).replace(/(?:啊|呀|哦|吧)$/u, '').trim()
  if (persona.length < 2 || persona.length > 200 || PLAIN_SPEECH.test(persona) || offerWord(persona)) return undefined
  return persona
}

/** A scope phrase inside a persona sentence. 「全员」 alone is not enough here; it is on the scope step. */
function explicitRange(text: string): boolean {
  return /只私聊|仅私聊|指定群|\bopen\b|开放|全开|所有群|全部群|每个群|任何群|群里都行|群里面|不限群|已接入|\bwr_|\boc_/i.test(text)
}

function withoutRangeClause(text: string): string {
  const cut = text.replace(/[，,]\s*.*(?:只私聊|仅私聊|指定群|\bopen\b|开放|全开|所有群|全部群|每个群|任何群|群里都行|群里面|不限群|已接入|wr_|oc_).*/i, '').trim()
  return cut.length >= 2 ? cut : text.trim()
}

/**
 * Where the line speaks. 「全员」「所有人」 means every connected group, not an allow list.
 * Open language maps to the Source's `otherChats: mentions` plus direct messages.
 */
function wantsOpen(text: string): boolean {
  return /\bopen\b/i.test(text)
    || /开放|全开|所有群|全部群|每个群|任何群|各个群|群里都行|群里都可以|群里都要|群里面都行|群里面都可以|所有群里面|不限群|到处都能说|到处可以|哪儿都能|哪里都能|哪儿都行|哪里都行|任何地方|谁都行|谁都可以|所有人|全员|已接入的群|都打开|全部打开|随便哪个群|哪个群都行|啥群都行|什么群都行/.test(text)
}

function chatIds(text: string): { chatId: string }[] {
  const labeled = [...text.matchAll(/(?:群|chatid|chat)\s*[:：]?\s*([A-Za-z0-9_@.+/=-]{1,128})/gi)].map(match => match[1] ?? '')
  const bare = [...text.matchAll(/\b(?:wr|oc)_[A-Za-z0-9_@.+/=-]{1,120}/gi)].map(match => match[0] ?? '')
  return [...new Set([...labeled, ...bare].filter(id => WECOM_ID.test(id)))].map(chatId => ({ chatId }))
}

function choice(text: string): ScopeChoice | 'need-group' | undefined {
  const trimmed = punct(text)
  if (/^(?:第二个|第2个|指定群|指定一个群|私聊加指定群|要指定群|私聊\s*[+＋]\s*指定群)$/.test(trimmed)) return 'need-group'
  if (/^(?:第一个|第1个)$/.test(trimmed)) return { directMessages: true, groups: [], otherChats: 'none' }
  if (/^(?:第三个|第3个|所有已接入的群|私聊\s*[+＋加]\s*所有(?:已接入的)?群)$/.test(trimmed)) {
    return { directMessages: true, groups: [], otherChats: 'mentions' }
  }
  if (/^(?:都行|都可以|都要|随便|哪里都好)$/.test(trimmed)) return { directMessages: true, groups: [], otherChats: 'mentions' }
  return undefined
}

function parseScope(text: string): ScopeChoice | 'need-group' | undefined {
  const picked = choice(text)
  if (picked) return picked
  const groups = chatIds(text)
  const onlyDm = /只私聊|仅私聊|只在私聊|仅在私聊|私聊就行|私聊就好|私聊即可|\bonly\s*dm\b|\bdm\s*only\b/i.test(text)
  const noDm = /不私聊|别私聊|不要私聊|关掉私聊|不在私聊/.test(text)
  const saysDm = /私聊|\bdm\b/i.test(text)
  if (onlyDm) return { directMessages: true, groups, otherChats: 'none' }
  if (wantsOpen(text)) return { directMessages: !noDm, groups, otherChats: 'mentions' }
  if (groups.length > 0 && saysDm) return { directMessages: true, groups, otherChats: 'none' }
  if (groups.length > 0) return { directMessages: false, groups, otherChats: 'none' }
  if (saysDm && !noDm) return { directMessages: true, groups: [], otherChats: 'none' }
  return undefined
}

function splitItems(text: string): string[] {
  const rough = text.split(/[、,，;；\n]+|(?:以及|还有|或者|或是)/).map(part => part.trim()).filter(Boolean)
  return rough.flatMap(part => {
    if (!part.includes('和')) return [part]
    const pieces = part.split('和').map(item => item.trim()).filter(Boolean)
    if (pieces.length >= 2 && pieces.every(item => item.length >= 2 && item.length <= 40)) return pieces
    return [part]
  }).map(item => item.replace(/^(?:直接回|比如|例如)[:：]?/, '').replace(/(?:吧|啊|呀)$/u, '').trim()).filter(Boolean)
}

function parseList(text: string, offered: readonly string[]): string[] | undefined {
  const trimmed = punct(text)
  if (acceptsExamples(trimmed)) return [...offered]
  const body = trimmed.replace(/^(?:直接回|直接回复|直接办|往下推进|需要你拍板|要你拍板|包括|比如|例如)[:：]?/, '').trim()
  const items = splitItems(body)
  if (!items.length || items.length > 20 || items.some(item => item.length > 80 || PLAIN_SPEECH.test(item))) return undefined
  return items
}

function parseEscalation(text: string): { name: string; wecomUserId?: string; feishuOpenId?: string }[] | undefined {
  const trimmed = punct(text)
  if (acceptsExamples(trimmed) || /^(?:就他|就她|就这个人)$/.test(trimmed)) return [{ name: '外贸负责人' }]
  const items = parseList(trimmed.replace(/^(?:卡住了)?(?:就)?找/, '').trim(), [])
  if (!items) return undefined
  const contacts = items.map(item => {
    const parts = item.split(/\s+/)
    const last = parts.at(-1) ?? ''
    if (parts.length >= 2 && FEISHU_OPEN_ID.test(last)) return { name: parts.slice(0, -1).join(' '), feishuOpenId: last }
    if (parts.length >= 2 && WECOM_ID.test(last)) return { name: parts.slice(0, -1).join(' '), wecomUserId: last }
    return { name: item }
  })
  if (contacts.some(contact => !contact.name || contact.name.length > 40)) return undefined
  return contacts
}

function parseErp(text: string): ErpConfig | undefined {
  const trimmed = text.trim()
  if (/salesforce|sap\b|erpnext|金蝶|用友/i.test(trimmed) && !/odoo/i.test(trimmed)) return undefined
  const turnsOn = /要接|接上|接一下|接\s*odoo|用\s*odoo|\bodoo\b/i.test(trimmed)
  if (/不接|别接|先不接|先不用|不需要|不用接|^(?:不用|没有|不)$/.test(trimmed) && !turnsOn) return { enabled: false }
  if (!turnsOn && !(/^接$/.test(trimmed) || (/接/.test(trimmed) && !/不接|别接/.test(trimmed)))) return undefined
  const models = trimmed.match(/[a-z]+\.[a-z]+/gi) ?? []
  if (models.some(model => model.toLowerCase() !== 'crm.lead')) return undefined
  const write = [...new Set([...trimmed.matchAll(/\b(phone|email_from|contact_name|partner_name|function|description)\b/g)].map(match => match[1] ?? ''))].filter(Boolean)
  return {
    enabled: true, adapter: 'odoo', sourceOfTruth: 'Odoo crm.lead',
    read: ['已有的电话、邮箱、联系人、公司'],
    write: write.length ? write : ['phone', 'email_from', 'contact_name'],
  }
}

function roleName(draft: GrillDraft): string {
  const persona = draft.persona ?? ''
  if (persona.includes('跟单同事')) return '跟单同事'
  const colleague = persona.match(/[\u4e00-\u9fff]{2,6}同事/)
  if (colleague?.[0]) return colleague[0]
  const name = draft.name?.trim() ?? ''
  if (name && name.length <= 12 && !PLAIN_SPEECH.test(name)) return name
  return '它自己'
}

function draftedSmoke(draft: GrillDraft): string {
  const role = roleName(draft)
  return role === '它自己' ? '在的。有事直接说。' : `在的。我是${role}。`
}

function wantsDraftedSmoke(text: string): boolean {
  return /^(?:你写|你来写|帮我写|写一句|随便写|随便|看着办|你定|你看着办)(?:一句|个招呼|吧)?$/.test(punct(text))
}

function parseSmoke(text: string, draft: GrillDraft): string | undefined {
  if (wantsDraftedSmoke(text)) return draftedSmoke(draft)
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed.length > 160 || PLAIN_SPEECH.test(trimmed)) return undefined
  return trimmed
}

function speaksForItself(text: string): boolean {
  return /^(?:它自己|他自己|她自己|就它|这条线|你来|你说|用它)$/.test(punct(text))
}

function parseFormatter(text: string, draft: GrillDraft): string | undefined {
  const trimmed = punct(text)
  if (!trimmed || PLAIN_SPEECH.test(trimmed)) return undefined
  if (speaksForItself(trimmed) || acceptsExamples(trimmed)) return roleName(draft)
  if (trimmed.length > 60) return undefined
  return trimmed
}

function whereSpeech(draft: GrillDraft): string {
  const named = draft.groups?.map(group => group.chatId).join('、') ?? ''
  if (draft.otherChats === 'mentions') {
    const where = draft.directMessages ? '可在私聊和所有已接入的群里说话' : '可在所有已接入的群里说话'
    return named ? `${where}，也点了 ${named}` : where
  }
  if (draft.directMessages && !named) return '只在私聊'
  if (draft.directMessages) return `私聊，加上群 ${named}`
  return named ? `只在这些群：${named}` : '还没定在哪说话'
}

function blank(slot: GrillSlot): GrillDraft {
  return { slot }
}

function summary(draft: GrillDraft): string {
  const erp = draft.erp?.enabled ? '接 Odoo' : '不接 Odoo'
  const where = whereSpeech(draft)
  const full = `${draft.name ?? ''}。${where}。直接回 ${(draft.autoReply ?? []).join('、')}。往下推进 ${(draft.autoAdvance ?? []).join('、')}。需要你拍板 ${(draft.humanApprove ?? []).join('、')}。选项由${draft.formatter ?? ''}来说。权限先不做。找 ${(draft.escalation ?? []).map(item => item.name).join('、')}。${erp}。招呼：${draft.smoke ?? ''}。回复「就这样」就接上。`
  return spoken(full, `${draft.name ?? '这条线'}。${where}。权限先不做。回复「就这样」就接上，回复「取消」作废。`)
}

function doneWhere(identity: BusinessIdentity): string {
  if (identity.scope.otherChats === 'mentions') {
    return identity.scope.directMessages ? '可在私聊和所有已接入的群里说话' : '可在所有已接入的群里说话'
  }
  if (!identity.scope.directMessages) return '在点名的群里就能用'
  if (identity.scope.groups.length === 0) return '私聊就能用，不用先在群里 @'
  return '私聊就能用，点名的群里也可以'
}

function doneSpeech(identity: BusinessIdentity): string {
  const where = doneWhere(identity)
  return spoken(
    `接好了。${identity.name} ${where}。权限先不做。招呼是：${identity.smoke}`,
    `接好了。${identity.name} ${where}。权限先不做。`,
  )
}

function finish(draft: GrillDraft): BusinessIdentity | undefined {
  const parsed = BusinessIdentitySchema.safeParse({
    id: draft.id, name: draft.name, persona: draft.persona,
    scope: { directMessages: draft.directMessages, otherChats: draft.otherChats ?? 'none', groups: draft.groups ?? [] },
    autoReply: draft.autoReply, autoAdvance: draft.autoAdvance, humanApprove: draft.humanApprove,
    formatter: draft.formatter, escalation: draft.escalation, erp: draft.erp, smoke: draft.smoke,
    permissions: 'deferred',
  })
  return parsed.success ? parsed.data : undefined
}

/** Another line already owns this group. The same id may keep its own chats. */
export function chatConflict(existing: readonly BusinessIdentity[], next: BusinessIdentity): string | undefined {
  for (const group of next.scope.groups) {
    const owner = existing.find(item => item.id !== next.id && item.scope.groups.some(chat => chat.chatId === group.chatId))
    if (owner) return `群 ${group.chatId} 已经是「${owner.name}」的`
  }
  return undefined
}

function cancelled(text: string): boolean {
  return /^(取消|算了|\/cancel)$/i.test(text.trim())
}
function confirmed(text: string): boolean {
  return /^(?:就这样|确认接上|确认|可以|行|好|好的|没问题|ok|okay|接上|对|是的|好了)[。.!！]?$/i.test(text.trim())
}

function go(draft: GrillDraft, slot: GrillSlot, extra: Partial<GrillDraft>, text: string): BotfatherTurn {
  const next: GrillDraft = { ...draft, ...extra, slot }
  delete next.asks
  delete next.listenFor
  return { handled: true, text, draft: next }
}

function reprompt(draft: GrillDraft, lines: readonly [string, string], extra?: Partial<GrillDraft>): BotfatherTurn {
  const asks = draft.asks === 1 ? 1 : 0
  return { handled: true, text: lines[asks], draft: { ...draft, ...extra, asks: asks === 0 ? 1 : 0 } }
}

function keep(draft: GrillDraft, slot: AskSlot): BotfatherTurn {
  return reprompt(draft, NUDGES[slot])
}

function askGroupId(draft: GrillDraft): BotfatherTurn {
  return reprompt(draft, GROUP_NUDGES, { listenFor: 'group-id' })
}

function confirmMiss(draft: GrillDraft): BotfatherTurn {
  return reprompt(draft, CONFIRM_NUDGES)
}

function fill(draft: GrillDraft, text: string, identities: readonly BusinessIdentity[]): BotfatherTurn {
  const slot = draft.slot
  if (emptyTalk(text)) {
    if (slot === 'confirm') return confirmMiss(draft)
    if (slot === 'scope' && draft.listenFor === 'group-id') return askGroupId(draft)
    return keep(draft, slot)
  }
  switch (slot) {
    case 'name': {
      const named = parseName(text)
      if (!named) return keep(draft, 'name')
      return go(draft, 'persona', named, QUESTIONS.persona)
    }
    case 'persona': {
      const persona = parsePersona(text)
      if (!persona) return keep(draft, 'persona')
      if (explicitRange(text)) {
        const scope = parseScope(text)
        const said = withoutRangeClause(persona)
        if (scope === 'need-group') return askGroupId({ ...draft, slot: 'scope', persona: said, asks: 0 })
        if (scope) return go(draft, 'autoReply', { persona: said, ...scope }, QUESTIONS.autoReply)
      }
      return go(draft, 'scope', { persona }, QUESTIONS.scope)
    }
    case 'scope': {
      const scope = parseScope(text)
      if (scope === 'need-group') return askGroupId(draft)
      if (!scope) return draft.listenFor === 'group-id' ? askGroupId(draft) : keep(draft, 'scope')
      return go(draft, 'autoReply', scope, QUESTIONS.autoReply)
    }
    case 'autoReply': {
      const autoReply = parseList(text, OFFERED.autoReply)
      if (!autoReply) return keep(draft, 'autoReply')
      return go(draft, 'autoAdvance', { autoReply }, QUESTIONS.autoAdvance)
    }
    case 'autoAdvance': {
      const autoAdvance = parseList(text, OFFERED.autoAdvance)
      if (!autoAdvance) return keep(draft, 'autoAdvance')
      return go(draft, 'humanApprove', { autoAdvance }, QUESTIONS.humanApprove)
    }
    case 'humanApprove': {
      const humanApprove = parseList(text, OFFERED.humanApprove)
      if (!humanApprove) return keep(draft, 'humanApprove')
      return go(draft, 'formatter', { humanApprove }, QUESTIONS.formatter)
    }
    case 'formatter': {
      const formatter = parseFormatter(text, draft)
      if (!formatter) return keep(draft, 'formatter')
      return go(draft, 'escalation', { formatter }, QUESTIONS.escalation)
    }
    case 'escalation': {
      const escalation = parseEscalation(text)
      if (!escalation) return keep(draft, 'escalation')
      return go(draft, 'erp', { escalation }, QUESTIONS.erp)
    }
    case 'erp': {
      const erp = parseErp(text)
      if (!erp) return keep(draft, 'erp')
      return go(draft, 'smoke', { erp }, QUESTIONS.smoke)
    }
    case 'smoke': {
      const smoke = parseSmoke(text, draft)
      if (!smoke) return keep(draft, 'smoke')
      return go(draft, 'confirm', { smoke }, summary({ ...draft, smoke }))
    }
    case 'confirm': {
      if (!confirmed(text)) return confirmMiss(draft)
      const identity = finish(draft)
      if (!identity) return { handled: true, text: '还没齐。回复「取消」重来。', draft }
      const conflict = chatConflict(identities, identity)
      if (conflict) return { handled: true, text: spoken(`${conflict}。换一个群，或回复「取消」。`, '这个群已经被别的线用了。回复「取消」重来。'), draft }
      return { handled: true, text: doneSpeech(identity), draft: null, wired: identity }
    }
    default: {
      const leftover: never = slot
      return leftover
    }
  }
}

/**
 * One DM turn of BotFather. Group chats are never handled. A reserved operator list, when non-empty, is only who may
 * enter the factory; everyone else keeps the ordinary companion line.
 */
export function botfatherTurn(input: {
  direct: boolean
  userid: string
  text: string
  route: FactoryRoute
  draft: GrillDraft | undefined
  identities: readonly BusinessIdentity[]
}): BotfatherTurn | { handled: false } {
  if (!input.direct || !WECOM_ID.test(input.userid)) return { handled: false }
  const starting = factoryStart(input.text)
  if (!input.route.ok) {
    if (input.draft || starting) return { handled: true, text: ROUTE_BROKEN, draft: null }
    return { handled: false }
  }
  if (input.route.operators.length > 0 && !input.route.operators.includes(input.userid)) return { handled: false }
  if (starting) {
    const named = starting.rest ? parseName(starting.rest) : undefined
    const draft = named ? { ...blank('persona'), id: named.id, name: named.name } : blank('name')
    return { handled: true, text: named ? QUESTIONS.persona : QUESTIONS.name, draft }
  }
  if (!input.draft) return { handled: false }
  if (cancelled(input.text)) return { handled: true, text: '好，这条先停。', draft: null }
  return fill(input.draft, input.text, input.identities)
}

export function smokeFor(identities: readonly BusinessIdentity[], direct: boolean, chatId: string): string | undefined {
  const matches = direct
    ? identities.filter(identity => identity.scope.directMessages)
    : identities.filter(identity => identity.scope.groups.some(group => group.chatId === chatId) || identity.scope.otherChats === 'mentions')
  return matches.length === 1 ? matches[0]!.smoke : undefined
}

/** Prompt fragment the companion reads for one wired line. */
export function companionFragment(identity: BusinessIdentity): string {
  const named = identity.scope.groups.length
    ? identity.scope.groups.map(group => {
      const channel = chatChannel(group.chatId) === 'feishu' ? 'Feishu' : 'WeCom'
      const listen = group.listen ? `, ${group.listen}` : ''
      return group.name ? `${channel} ${group.chatId} (${group.name}${listen})` : `${channel} ${group.chatId}${listen}`
    }).join(', ')
    : 'none'
  const groups = identity.scope.otherChats === 'mentions'
    ? (identity.scope.groups.length ? `every connected group; also ${named}` : 'every connected group')
    : named
  const erp = identity.erp.enabled
    ? `Odoo is on. Source of truth: ${identity.erp.sourceOfTruth}. Read: ${identity.erp.read.join('; ')}. Write: ${identity.erp.write.join(', ')}. Use the existing Odoo Source only.`
    : 'ERP is off.'
  const escalation = identity.escalation.map(item => {
    const ids = [item.wecomUserId, item.feishuOpenId].filter(Boolean).join(', ')
    return ids ? `${item.name} (${ids})` : item.name
  }).join(', ')
  const open = identity.scope.otherChats !== 'mentions' ? ''
    : `${identity.scope.directMessages ? 'May speak in direct messages and every connected group.' : 'May speak in every connected group.'}\n\n`
  return [
    `# ${identity.name}`,
    '',
    `Template id \`${identity.id}\`. This line shares the existing WeCom bot and the existing Feishu bot. BotFather wired it from a direct message on either channel. It is active without a group mention. WeCom still only pushes group messages that @ the bot. Feishu group ids start with oc_.`,
    '',
    `Persona: ${identity.persona}`,
    '',
    open + `Direct messages: ${identity.scope.directMessages ? 'yes' : 'no'}.`,
    `Groups: ${groups}.`,
    '',
    `Auto-reply: ${identity.autoReply.join('; ')}.`,
    `Auto-advance: ${identity.autoAdvance.join('; ')}.`,
    `Needs a decision (需要你拍板): ${identity.humanApprove.join('; ')}.`,
    `Formatter: ${identity.formatter}.`,
    `Escalate to: ${escalation}.`,
    'Permissions: deferred. Do not invent an allow list.',
    '',
    erp,
    '',
    `Smoke greeting: ${identity.smoke}`,
    '',
  ].join('\n')
}

export { SAVE_FAILED }
