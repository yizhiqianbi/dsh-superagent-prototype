/** Points the grill at the role directory. It does not copy a role's chats onto this bot. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { assertNoSecret } from './secrets.ts'

/** Turns one bundle plugin on in a profile patch without rewriting the rest of the file. */
export function enablePlugin(patch: string, id: string): string {
  const newline = patch.endsWith('\n') || patch.length === 0
  const lines = patch.split('\n')
  const marker = new RegExp(`^- id: ${id}\\s*$`)
  let found = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (marker.test(lines[index] ?? '')) found = index
  }
  if (found < 0) {
    const addition = `- id: ${id}\n  disabled: false\n`
    return `${patch}${patch.length > 0 && !newline ? '\n' : ''}${addition}`
  }
  let end = lines.length
  for (let index = found + 1; index < lines.length; index += 1) {
    if (/^- id: /.test(lines[index] ?? '')) { end = index; break }
  }
  let disabled = -1
  for (let index = found + 1; index < end; index += 1) {
    if (/^\s+disabled:\s*/.test(lines[index] ?? '')) disabled = index
  }
  if (disabled >= 0) lines[disabled] = (lines[disabled] ?? '').replace(/disabled:\s*\S+/, 'disabled: false')
  else lines.splice(found + 1, 0, '  disabled: false')
  const joined = lines.join('\n')
  return newline && !joined.endsWith('\n') ? `${joined}\n` : joined
}

export const enableWecomPlugin = (patch: string): string => enablePlugin(patch, 'dsh-superagent-wecom')
export const enableFeishuPlugin = (patch: string): string => enablePlugin(patch, 'dsh-superagent-feishu')

export function webPort(patch: string): number {
  const blocks = patch.split(/^- id: /m)
  const web = blocks.find(block => block.startsWith('webserver\n') || block.startsWith('webserver\r'))
  const port = Number(web?.match(/^\s*port:\s*(\d+)\s*$/m)?.[1] ?? '')
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 3082
}

function chatRows(value: unknown): { chatId: string; name?: string }[] {
  if (!Array.isArray(value)) return []
  return value.flatMap(item => {
    if (!item || typeof item !== 'object' || !('chatId' in item) || typeof item.chatId !== 'string') return []
    const name = 'name' in item && typeof item.name === 'string' && item.name.trim() ? item.name : undefined
    return [{ chatId: item.chatId, ...name ? { name } : {} }]
  })
}

function stripSecrets(current: unknown): Record<string, unknown> {
  const config = current && typeof current === 'object' ? { ...current as Record<string, unknown> } : {}
  for (const key of Object.keys(config)) {
    if (/secret|password|token/i.test(key)) delete config[key]
  }
  return config
}

/** Direct messages stay on so the grill can talk. This bot's own chats stay as they are. A role's groups are not copied here. Secrets are dropped if they were stored. */
export function mergeWecomConfig(current: unknown, identitiesDir: string): Record<string, unknown> {
  const config = stripSecrets(current)
  config.chats = chatRows(config.chats)
  config.directMessages = true
  config.identitiesDir = identitiesDir
  return config
}

/** Feishu keeps its CLI, its chats, and its other-chat policy. Direct messages stay on for the grill. A role's `oc_` groups are not copied here. */
export function mergeFeishuConfig(current: unknown, identitiesDir: string): Record<string, unknown> {
  const config = stripSecrets(current)
  config.chats = chatRows(config.chats).map(chat => {
    const row = Array.isArray(config.chats) ? config.chats.find(item => item && typeof item === 'object' && 'chatId' in item && item.chatId === chat.chatId) : undefined
    const listen = row && typeof row === 'object' && 'listen' in row && (row.listen === 'all' || row.listen === 'mentions') ? row.listen : 'mentions'
    return { ...chat, listen }
  })
  config.directMessages = true
  config.identitiesDir = identitiesDir
  return config
}

interface SettingsBody { sources?: { id: string; revision: number; value: { enabled: boolean; config: unknown } }[] }

/** Records the role directory and direct messages for the grill. Returns a short status that never includes a secret. */
export async function pushWecomSettings(identitiesDir: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const profile = dirname(dirname(identitiesDir))
  let patch: string
  try { patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8') } catch { return '没有找到 cordis.patch.yml，企业微信设置没改。' }
  const port = webPort(patch)
  const headers = { 'content-type': 'application/json', 'x-orchestrator-request': '1' }
  const url = `http://127.0.0.1:${port}/orchestrator/api/settings`
  let response: Response
  try { response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(3000) }) }
  catch { return '面板没开，企业微信设置还没改。角色文件已经写好的话，在目录里，没有并到这个机器人上。' }
  if (!response.ok) return `面板没有返回设置（${response.status}）。身份文件已经写好。没有把角色并到这个机器人上。`
  const body = await response.json() as SettingsBody
  const notes: string[] = []
  let restarting = false
  for (const id of ['wecom', 'feishu'] as const) {
    const source = body.sources?.find(item => item.id === id)
    const label = id === 'wecom' ? '企业微信' : '飞书'
    if (!source) { notes.push(`面板里还没有${label}来源。`); continue }
    const config = id === 'wecom'
      ? mergeWecomConfig(source.value.config, identitiesDir)
      : mergeFeishuConfig(source.value.config, identitiesDir)
    assertNoSecret(JSON.stringify(config))
    const put = await fetchImpl(`${url}/source:${id}`, {
      method: 'PUT', headers, body: JSON.stringify({ revision: source.revision, value: { enabled: true, config } }),
      signal: AbortSignal.timeout(3000),
    })
    if (!put.ok) { notes.push(`${label}设置没有保存（${put.status}）。`); continue }
    const saved = await put.json() as { restarting?: boolean }
    restarting = restarting || saved.restarting === true
    notes.push(`${label}只记下了私聊工厂的目录。`)
  }
  if (restarting) notes.push('服务正在重启。')
  notes.push('没有新建 BotID，也没有把角色并到这个机器人上。')
  return notes.join('')
}
