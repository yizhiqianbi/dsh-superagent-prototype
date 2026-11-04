/** BotFather's entry on a direct message, and the role package a settled line leaves for a new bot. */
import { createHash } from 'node:crypto'
import { checkedImText } from '../infra/text.ts'
import { WECOM_FILE_MISSED, WECOM_FILE_NOTE, WECOM_IMAGE_EXTRA, WECOM_IMAGE_MISSED, WECOM_QUOTE } from '../sources/wecom-trigger.ts'
import type { BusinessIdentity } from './schema.ts'
import { chatChannel } from './schema.ts'

const STARTS = ['新建业务线', '新业务线', '开一条线', '做一条业务线', '/botfather', '/new', 'botfather']

export const BOTFATHER_INIT = '要开新线，先在这台机器跑 botfactory-wire --init，然后再发「新建业务线」。角色写好后另挂，BotID 你自己建。'
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

function namedGroups(identity: BusinessIdentity, channel: 'wecom' | 'feishu'): string {
  const groups = identity.scope.groups.filter(group => chatChannel(group.chatId) === channel)
  if (!groups.length) return '无'
  return groups.map(group => {
    const listen = group.listen === 'all' ? '，listen: all' : ''
    return group.name ? `${group.chatId}（${group.name}${listen}）` : `${group.chatId}${listen}`
  }).join('、')
}

/** What the hang note says about groups. WeCom still requires an @. `listen: all` is Feishu only. */
function scopeNote(identity: BusinessIdentity): string {
  const registered = `已登记的企业微信群：${namedGroups(identity, 'wecom')}。已登记的飞书群：${namedGroups(identity, 'feishu')}。`
  const platform = '企业微信长连接只推送群里 @ 机器人的消息，没有不 @ 也收的模式。飞书 oc_ 群可以写 listen: all，那只对飞书有效。'
  switch (identity.scope.otherChats) {
    case 'mentions':
      return [
        '主动接群：私聊，已登记的群，以及其余已接入的群里 @ 机器人的消息。',
        platform,
        '挂到新机器人时，把已登记的群写进那个来源的「接收的群」，「其他群」选「接收 @」。不要改现在这个来源的开关。',
        registered,
      ].join('\n')
    case 'none':
      return [
        `不接其余的群，只留已登记的群。私聊${identity.scope.directMessages ? '开' : '关'}。`,
        platform,
        '这些群记在角色里，不会自动加进现在这个机器人。挂到新机器人时再登记，其他群保持不接收。',
        registered,
      ].join('\n')
    default: {
      const unreachable: never = identity.scope.otherChats
      return unreachable
    }
  }
}

/**
 * What the direct message says after a role is written. Short enough for the WeCom send limit.
 * It names where a BotID and Secret go. It does not ask for either value.
 */
export function hangNotice(identity: BusinessIdentity): string {
  return checkedImText([
    `角色「${identity.name}」已写好，还没挂到这个机器人上。`,
    '文件在 botfactory 的 identities、companions、roles。',
    '请你新建企业微信智能机器人，选长连接。',
    'BotID 放 WECOM_BOT_ID，Secret 放 WECOM_BOT_SECRET，不要发在这里。',
    '把这份角色指过去，不要并到现在这个机器人。',
  ].join(''))
}

/** The hang note stored beside the role. Longer than the direct message, still with no credential value. */
export function roleNote(identity: BusinessIdentity): string {
  const reach = scopeNote(identity)
  const feishu = identity.scope.groups.some(group => chatChannel(group.chatId) === 'feishu')
    ? ['飞书群只记在角色里。不改飞书命令行，也不改飞书凭证。', '']
    : []
  return [
    `# ${identity.name}`,
    '',
    '这是一份给新的企业微信智能机器人用的角色。分马甲：BotID 你自己建，BotFather 只管 role。这里不写、不收 BotID 和 Secret，也不调用接口去创建机器人。',
    '',
    '## 写了什么',
    '',
    `- \`botfactory/identities/${identity.id}.yml\`：人设、SOP、范围、模板。`,
    `- \`botfactory/companions/${identity.id}.md\`：这条线怎么说话。`,
    `- \`botfactory/roles/${identity.id}.md\`：这份挂载说明。`,
    '',
    `招呼：${identity.smoke}`,
    reach,
    '权限：deferred。这不是允许名单。',
    ...feishu,
    '## 你自己挂',
    '',
    '1. 在企业微信管理后台新建一个智能机器人。API 模式选「长连接」。',
    '2. 把那个机器人的 BotID 放到它自己的环境变量 `WECOM_BOT_ID`，或写进来源里的 BotID 栏。把长连接 Secret 放到 `WECOM_BOT_SECRET`。不要把这两个值发回对话，也不要写进身份文件。',
    '3. 让那个 profile 使用上面的身份文件和说法。已登记的群写进那个机器人来源的「接收的群」。其他群按这份角色：mentions 是接收 @，none 是不接收。企业微信群里仍然要 @。不要把这条线并进现在跟你说话的这个机器人。',
    '',
    '一个进程里，同一个 BotID 只能保持一条长连接。新马甲用新的 BotID。',
    '',
  ].join('\n')
}

function listedChats(identity: BusinessIdentity): string {
  if (!identity.scope.groups.length) return 'none'
  return identity.scope.groups.map(group => {
    const channel = chatChannel(group.chatId) === 'feishu' ? 'Feishu' : 'WeCom'
    const listen = group.listen ? `, listen: ${group.listen}` : ''
    return group.name ? `${channel} ${group.chatId} (${group.name}${listen})` : `${channel} ${group.chatId}${listen}`
  }).join(', ')
}

/** Where the new bot may speak. WeCom still requires an @. `listen: all` is Feishu only. */
function scopeLines(identity: BusinessIdentity): string[] {
  const listed = listedChats(identity)
  const direct = `Direct messages: ${identity.scope.directMessages ? 'yes' : 'no'}.`
  const platform = 'WeCom delivers a group message only when the bot is @ mentioned. There is no WeCom listen:all. A Feishu oc_ chat may set listen: all.'
  switch (identity.scope.otherChats) {
    case 'mentions':
      return [
        direct,
        identity.scope.groups.length
          ? `Groups: the registered chats, and every other connected group when the bot is @ mentioned. Registered: ${listed}.`
          : 'Groups: every connected group when the bot is @ mentioned. Registered chats: none.',
        'On the new bot, register those chats and set other chats to mentions.',
        platform,
      ]
    case 'none':
      return [
        direct,
        `Groups: only the registered chats. Registered: ${listed}.`,
        'Other connected groups stay off.',
        platform,
      ]
    default: {
      const unreachable: never = identity.scope.otherChats
      return unreachable
    }
  }
}

/** Prompt fragment the new bot reads for this role. It is not worn by the bot that ran the conversation. */
export function companionFragment(identity: BusinessIdentity): string {
  const erp = identity.erp.enabled
    ? `Odoo is on. Source of truth: ${identity.erp.sourceOfTruth}. Read: ${identity.erp.read.join('; ')}. Write: ${identity.erp.write.join(', ')}. Use the existing Odoo Source only.`
    : 'ERP is off.'
  const escalation = identity.escalation.map(item => {
    const ids = [item.wecomUserId, item.feishuOpenId].filter(Boolean).join(', ')
    return ids ? `${item.name} (${ids})` : item.name
  }).join(', ')
  return [
    `# ${identity.name}`,
    '',
    `Template id \`${identity.id}\`. This is a role for a new WeCom bot the operator creates. BotFather writes the role and does not hang it on the bot that held the conversation. Do not ask for a BotID or a Secret. Feishu group ids start with oc_. Recording chats here does not change the bot that is talking now.`,
    '',
    `Persona: ${identity.persona}`,
    '',
    ...scopeLines(identity),
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
