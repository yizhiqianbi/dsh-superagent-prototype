/** Copies wired lines into the WeCom Source settings through the loopback management API. */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { BusinessIdentity } from './schema.ts'
import { assertNoSecret } from './secrets.ts'
import { unionChats } from './store.ts'

/** Turns the WeCom plugin on in a profile patch without rewriting the rest of the file. */
export function enableWecomPlugin(patch: string): string {
  const newline = patch.endsWith('\n') || patch.length === 0
  const lines = patch.split('\n')
  let found = -1
  for (let index = 0; index < lines.length; index += 1) {
    if (/^- id: dsh-superagent-wecom\s*$/.test(lines[index] ?? '')) found = index
  }
  if (found < 0) {
    const addition = `- id: dsh-superagent-wecom\n  disabled: false\n`
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

/** The Source config after BotFather wires lines. Direct messages stay on. Secrets are dropped if they were stored. */
export function mergeWecomConfig(current: unknown, identitiesDir: string, identities: readonly BusinessIdentity[]): Record<string, unknown> {
  const config = current && typeof current === 'object' ? { ...current as Record<string, unknown> } : {}
  for (const key of Object.keys(config)) {
    if (/secret|password|token/i.test(key)) delete config[key]
  }
  const extra = identities.flatMap(identity => identity.scope.groups.map(group => ({
    chatId: group.chatId, ...group.name ? { name: group.name } : {},
  })))
  config.chats = unionChats(chatRows(config.chats), extra)
  config.directMessages = true
  config.identitiesDir = identitiesDir
  return config
}

interface SettingsBody { sources?: { id: string; revision: number; value: { enabled: boolean; config: unknown } }[] }

/** Pushes chats and the identity directory. Returns a short status that never includes a secret. */
export async function pushWecomSettings(identitiesDir: string, identities: readonly BusinessIdentity[], fetchImpl: typeof fetch = fetch): Promise<string> {
  const profile = dirname(dirname(identitiesDir))
  let patch: string
  try { patch = readFileSync(join(profile, 'cordis.patch.yml'), 'utf8') } catch { return '没有找到 cordis.patch.yml，企业微信设置没改。' }
  const port = webPort(patch)
  const headers = { 'content-type': 'application/json', 'x-orchestrator-request': '1' }
  const url = `http://127.0.0.1:${port}/orchestrator/api/settings`
  let response: Response
  try { response = await fetchImpl(url, { headers, signal: AbortSignal.timeout(3000) }) }
  catch { return '面板没开，企业微信设置还没改。身份文件已经写好。' }
  if (!response.ok) return `面板没有返回设置（${response.status}）。身份文件已经写好。`
  const body = await response.json() as SettingsBody
  const source = body.sources?.find(item => item.id === 'wecom')
  if (!source) return '面板里还没有企业微信来源。先启用插件并重启，再跑一次。'
  const config = mergeWecomConfig(source.value.config, identitiesDir, identities)
  assertNoSecret(JSON.stringify(config))
  const put = await fetchImpl(`${url}/source:wecom`, {
    method: 'PUT', headers, body: JSON.stringify({ revision: source.revision, value: { enabled: true, config } }),
    signal: AbortSignal.timeout(3000),
  })
  if (!put.ok) return `企业微信设置没有保存（${put.status}）。身份文件已经写好。`
  const saved = await put.json() as { restarting?: boolean }
  return saved.restarting ? '企业微信设置已保存，服务正在重启。没有新的 BotID。' : '企业微信已接上这些群，私聊开着。没有新的 BotID。'
}
