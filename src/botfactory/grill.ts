/** BotFather's entry on a direct message, and the speech a wired line leaves for the companion. */
import { createHash } from 'node:crypto'
import { WECOM_FILE_MISSED, WECOM_FILE_NOTE, WECOM_IMAGE_EXTRA, WECOM_IMAGE_MISSED, WECOM_QUOTE } from '../sources/wecom-trigger.ts'
import type { BusinessIdentity } from './schema.ts'
import { chatChannel } from './schema.ts'

const STARTS = ['新建业务线', '新业务线', '开一条线', '做一条业务线', '/botfather', '/new', 'botfather']

export const BOTFATHER_INIT = '要开新线，先在这台机器跑 botfactory-wire --init，然后再发「新建业务线」。还是这一个机器人。'
export const ROUTE_BROKEN = 'BotFather 的路由文件读不了，私聊工厂先停着。'
export const SAVE_FAILED = '没存上。再发一次。'
export const FACTORY_STOP = '好，这条先停。'

/** A picture token or a failed download is not the command. The words around it still are. */
function spokenCommand(text: string): string {
  return text.trim().split('\n').map(line => line.trim()).filter(line => {
    if (!line || line === WECOM_QUOTE) return false
    if (line === WECOM_FILE_NOTE || line === WECOM_IMAGE_MISSED || line === WECOM_FILE_MISSED || line === WECOM_IMAGE_EXTRA) return false
    return !/^\[(?:图片|文件) wximg_[1-9]\d*\]$/.test(line)
  }).join('\n')
}

/** A factory command, and any words typed after it. Longer phrases are matched first. */
export function factoryStart(text: string): { rest: string } | undefined {
  const trimmed = spokenCommand(text)
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

export function factoryStop(text: string): boolean {
  return /^(取消|算了|\/cancel)$/i.test(text.trim())
}

/** The id stored on disk. A Latin token is kept; a Chinese name gets a stable `line-` id. */
export function identityId(name: string): string {
  const latin = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
  if (/^[a-z][a-z0-9-]{1,40}$/.test(latin) && latin !== 'botfather') return latin
  return `line-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
}

/** Another line already owns this group. The same id may keep its own chats. */
export function chatConflict(existing: readonly BusinessIdentity[], next: BusinessIdentity): string | undefined {
  for (const group of next.scope.groups) {
    const owner = existing.find(item => item.id !== next.id && item.scope.groups.some(chat => chat.chatId === group.chatId))
    if (owner) return `群 ${group.chatId} 已经是「${owner.name}」的`
  }
  return undefined
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
