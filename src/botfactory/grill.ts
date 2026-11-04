/** BotFather's direct-message grill: one question at a time, then a business-line identity. */
import { createHash } from 'node:crypto'
import { wordCount, IM_WORDS } from '../infra/text.ts'
import { WECOM_ID } from '../sources/wecom-trigger.ts'
import { BusinessIdentitySchema, PLAIN_SPEECH, type BusinessIdentity, type ErpConfig, type GrillDraft, type GrillSlot } from './schema.ts'

const STARTS = ['新建业务线', '新业务线', '开一条线', '做一条业务线', '/botfather', '/new', 'botfather']
const QUESTIONS: Record<Exclude<GrillSlot, 'confirm'>, string> = {
  name: '这条线叫什么？例如：外贸跟单伴侣。',
  persona: '用一句话说它是谁。例如：你是跟单同事，口语盯客户、订单和到账。',
  scope: '它在哪说话？「只私聊」马上能用。要加群就写：私聊，群 wr_xxx。',
  autoReply: '哪些话直接回？例如：打招呼、问进度。',
  autoAdvance: '哪些事直接往下推进？例如：跟单、催办、到账确认。',
  humanApprove: '哪些事要对方拍板？例如：改价格、承诺交期。',
  formatter: '谁来把选项说清楚？例如：跟单同事。',
  escalation: '权限先不做。卡住了找谁？例如：外贸负责人。',
  erp: '要接 Odoo 吗？回复「不接」，或「接 Odoo，以 crm.lead 为准，写 phone」。',
  smoke: '私聊打招呼说哪句？用口语，别写内部词。',
}
export const BOTFATHER_INIT = '要开新线，先在这台机器跑 botfactory-wire --init，然后再发「新建业务线」。还是这一个机器人。'
const ROUTE_BROKEN = 'BotFather 的路由文件读不了，私聊工厂先停着。'
const SAVE_FAILED = '没存上。再发一次。'
const SMOKE_RETRY = '这句不行。用口语说你在，别写内部词。'

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

function parseName(text: string): { id: string; name: string } | undefined {
  const trimmed = text.trim()
  const pair = /^([a-z][a-z0-9-]{1,40})\s+(.+)$/.exec(trimmed)
  if (pair?.[1] && pair[2] && pair[1] !== 'botfather') {
    const name = pair[2].trim()
    if (name.length > 0 && name.length <= 40 && !PLAIN_SPEECH.test(name)) return { id: pair[1], name }
  }
  if (!trimmed || trimmed.length > 40 || trimmed === 'botfather' || PLAIN_SPEECH.test(trimmed)) return undefined
  return { id: identityId(trimmed), name: trimmed }
}

function parseScope(text: string): { directMessages: boolean; groups: { chatId: string }[] } | undefined {
  const ids = [...text.matchAll(/(?:群|chatid|chat)\s*[:：]?\s*([A-Za-z0-9_@.+/=-]{1,128})/gi)]
    .map(match => match[1] ?? '')
    .filter(id => WECOM_ID.test(id))
  const groups = [...new Set(ids)].map(chatId => ({ chatId }))
  if (/只私聊|仅私聊/.test(text)) return { directMessages: true, groups: [] }
  if (groups.length && /私聊|\bdm\b/i.test(text)) return { directMessages: true, groups }
  if (groups.length) return { directMessages: false, groups }
  if (/私聊|\bdm\b/i.test(text)) return { directMessages: true, groups: [] }
  return undefined
}

function parseList(text: string): string[] | undefined {
  const items = text.split(/[、,，;\n]/).map(item => item.trim()).filter(Boolean)
  if (!items.length || items.length > 20 || items.some(item => item.length > 80 || PLAIN_SPEECH.test(item))) return undefined
  return items
}

function parseEscalation(text: string): { name: string; wecomUserId?: string }[] | undefined {
  const items = parseList(text)
  if (!items) return undefined
  const contacts = items.map(item => {
    const parts = item.split(/\s+/)
    const last = parts.at(-1) ?? ''
    if (parts.length >= 2 && WECOM_ID.test(last)) return { name: parts.slice(0, -1).join(' '), wecomUserId: last }
    return { name: item }
  })
  if (contacts.some(contact => !contact.name || contact.name.length > 40)) return undefined
  return contacts
}

function parseErp(text: string): ErpConfig | undefined {
  const trimmed = text.trim()
  if (trimmed.includes('不接') || /^(不用|不需要|没有)$/.test(trimmed)) return { enabled: false }
  if (!/接|odoo/i.test(trimmed)) return undefined
  const models = trimmed.match(/[a-z]+\.[a-z]+/gi) ?? []
  if (models.some(model => model.toLowerCase() !== 'crm.lead')) return undefined
  const write = [...new Set([...trimmed.matchAll(/\b(phone|email_from|contact_name|partner_name|function|description)\b/g)].map(match => match[1] ?? ''))]
  return {
    enabled: true, adapter: 'odoo', sourceOfTruth: 'Odoo crm.lead',
    read: ['已有的电话、邮箱、联系人、公司'],
    write: write.filter(Boolean).length ? write.filter(Boolean) : ['phone', 'email_from', 'contact_name'],
  }
}

function parseSmoke(text: string): string | undefined {
  const trimmed = text.trim()
  if (trimmed.length < 2 || trimmed.length > 160 || /闸门|呈报|WECOM_BOT_SECRET|\bBotID\b|\bsecret\b/i.test(trimmed)) return undefined
  return trimmed
}

function blank(slot: GrillSlot): GrillDraft {
  return { slot }
}

function summary(draft: GrillDraft): string {
  const erp = draft.erp?.enabled ? `接 Odoo，以${draft.erp.sourceOfTruth}为准` : '不接 Odoo'
  const groups = draft.groups?.length ? draft.groups.map(group => group.chatId).join('、') : '无'
  const full = `${draft.name ?? ''}。私聊${draft.directMessages ? '开' : '关'}，群 ${groups}。自动回 ${(draft.autoReply ?? []).join('、')}。往下推进 ${(draft.autoAdvance ?? []).join('、')}。要你拍板 ${(draft.humanApprove ?? []).join('、')}。选项由${draft.formatter ?? ''}来说。权限先不做。找 ${(draft.escalation ?? []).map(item => item.name).join('、')}。${erp}。招呼：${draft.smoke ?? ''}。回复「就这样」就接上。`
  return spoken(full, `${draft.name ?? '这条线'} 对过了。权限先不做。回复「就这样」就接上，回复「取消」作废。`)
}

function doneSpeech(identity: BusinessIdentity): string {
  return spoken(
    `接好了。${identity.name} 私聊就能用，不用先在群里 @。权限先不做。招呼是：${identity.smoke}`,
    `接好了。${identity.name} 私聊就能用。权限先不做。`,
  )
}

function finish(draft: GrillDraft): BusinessIdentity | undefined {
  const parsed = BusinessIdentitySchema.safeParse({
    id: draft.id, name: draft.name, persona: draft.persona,
    scope: { directMessages: draft.directMessages, groups: draft.groups ?? [] },
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
  return /^(就这样|确认接上|\/done)$/i.test(text.trim())
}

function fill(draft: GrillDraft, text: string, identities: readonly BusinessIdentity[]): BotfatherTurn {
  const slot = draft.slot
  const keep = (retry: string): BotfatherTurn => ({ handled: true, text: retry, draft })
  switch (slot) {
    case 'name': {
      const named = parseName(text)
      if (!named) return keep(QUESTIONS.name)
      return { handled: true, text: QUESTIONS.persona, draft: { ...draft, slot: 'persona', id: named.id, name: named.name } }
    }
    case 'persona': {
      const persona = text.trim()
      if (persona.length < 1 || persona.length > 200 || PLAIN_SPEECH.test(persona)) return keep(QUESTIONS.persona)
      return { handled: true, text: QUESTIONS.scope, draft: { ...draft, slot: 'scope', persona } }
    }
    case 'scope': {
      const scope = parseScope(text)
      if (!scope) return keep(QUESTIONS.scope)
      return { handled: true, text: QUESTIONS.autoReply, draft: { ...draft, slot: 'autoReply', ...scope } }
    }
    case 'autoReply': {
      const autoReply = parseList(text)
      if (!autoReply) return keep(QUESTIONS.autoReply)
      return { handled: true, text: QUESTIONS.autoAdvance, draft: { ...draft, slot: 'autoAdvance', autoReply } }
    }
    case 'autoAdvance': {
      const autoAdvance = parseList(text)
      if (!autoAdvance) return keep(QUESTIONS.autoAdvance)
      return { handled: true, text: QUESTIONS.humanApprove, draft: { ...draft, slot: 'humanApprove', autoAdvance } }
    }
    case 'humanApprove': {
      const humanApprove = parseList(text)
      if (!humanApprove) return keep(QUESTIONS.humanApprove)
      return { handled: true, text: QUESTIONS.formatter, draft: { ...draft, slot: 'formatter', humanApprove } }
    }
    case 'formatter': {
      const formatter = text.trim()
      if (!formatter || formatter.length > 60 || PLAIN_SPEECH.test(formatter)) return keep(QUESTIONS.formatter)
      return { handled: true, text: QUESTIONS.escalation, draft: { ...draft, slot: 'escalation', formatter } }
    }
    case 'escalation': {
      const escalation = parseEscalation(text)
      if (!escalation) return keep(QUESTIONS.escalation)
      return { handled: true, text: QUESTIONS.erp, draft: { ...draft, slot: 'erp', escalation } }
    }
    case 'erp': {
      const erp = parseErp(text)
      if (!erp) return keep(QUESTIONS.erp)
      return { handled: true, text: QUESTIONS.smoke, draft: { ...draft, slot: 'smoke', erp } }
    }
    case 'smoke': {
      const smoke = parseSmoke(text)
      if (!smoke) return keep(SMOKE_RETRY)
      const next: GrillDraft = { ...draft, slot: 'confirm', smoke }
      return { handled: true, text: summary(next), draft: next }
    }
    case 'confirm': {
      if (!confirmed(text)) return keep(summary(draft))
      const identity = finish(draft)
      if (!identity) return keep('还没齐。回复「取消」重来。')
      const conflict = chatConflict(identities, identity)
      if (conflict) return keep(spoken(`${conflict}。换一个群，或回复「取消」。`, '这个群已经被别的线用了。回复「取消」重来。'))
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
    : identities.filter(identity => identity.scope.groups.some(group => group.chatId === chatId))
  return matches.length === 1 ? matches[0]!.smoke : undefined
}

/** Prompt fragment the companion reads for one wired line. */
export function companionFragment(identity: BusinessIdentity): string {
  const groups = identity.scope.groups.length
    ? identity.scope.groups.map(group => group.name ? `${group.chatId} (${group.name})` : group.chatId).join(', ')
    : 'none'
  const erp = identity.erp.enabled
    ? `Odoo is on. Source of truth: ${identity.erp.sourceOfTruth}. Read: ${identity.erp.read.join('; ')}. Write: ${identity.erp.write.join(', ')}. Use the existing Odoo Source only.`
    : 'ERP is off.'
  const escalation = identity.escalation.map(item => item.wecomUserId ? `${item.name} (${item.wecomUserId})` : item.name).join(', ')
  return [
    `# ${identity.name}`,
    '',
    `Template id \`${identity.id}\`. This line shares the one WeCom bot. BotFather wired it from a direct message. It is active without a group mention. The platform still only pushes group messages that @ the bot.`,
    '',
    `Persona: ${identity.persona}`,
    '',
    `Direct messages: ${identity.scope.directMessages ? 'yes' : 'no'}.`,
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
