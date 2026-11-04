/** Applies a business-line identity onto the local superagent profile and the one WeCom bot. */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { chatConflict } from './grill.ts'
import { scrub } from './secrets.ts'
import { enableWecomPlugin, pushWecomSettings } from './settings.ts'
import { ensureRoute, loadIdentities, openFactory, parseIdentityFile } from './store.ts'
import type { BusinessIdentity } from './schema.ts'

export interface WireOptions {
  argv: string[]
  env?: NodeJS.ProcessEnv
  home?: string
  fetch?: typeof fetch
  log?: (line: string) => void
  error?: (line: string) => void
}

function usage(): string {
  return '用法: botfactory-wire [--dry-run] [--profile 目录] [--init] [身份文件.yml]\nBotFather 是这一个企业微信机器人的私聊工厂，不会新开 BotID。'
}

/** The superagent profile that already has a cordis patch, when one is on this machine. */
export function profileDir(explicit: string | undefined, env: NodeJS.ProcessEnv, home: string): string | undefined {
  if (explicit) return explicit
  const root = env.DSH_HOME || join(home, '.dsh')
  const name = env.DSH_SUPERAGENT_PROFILE || 'superagent'
  const dir = join(root, 'profiles', name)
  return existsSync(join(dir, 'cordis.patch.yml')) ? dir : undefined
}

function parseArgs(argv: string[]): { dryRun: boolean; init: boolean; help: boolean; profile?: string; file?: string } {
  const args = [...argv]
  let dryRun = false
  let init = false
  let help = false
  let profile: string | undefined
  const files: string[] = []
  while (args.length) {
    const arg = args.shift()
    if (arg === undefined) break
    if (arg === '--dry-run') dryRun = true
    else if (arg === '--init') init = true
    else if (arg === '--help' || arg === '-h') help = true
    else if (arg === '--profile') {
      const value = args.shift()
      if (!value) throw new Error('--profile 后面要跟目录')
      profile = value
    } else if (arg.startsWith('--')) throw new Error(`不认识的参数 ${arg}`)
    else files.push(arg)
  }
  if (files.length > 1) throw new Error('一次只接一条业务线')
  return { dryRun, init, help, profile, file: files[0] }
}

function identitiesDir(profile: string): string {
  return join(profile, 'botfactory', 'identities')
}

function describe(identity: BusinessIdentity, profile: string | undefined): string[] {
  const dir = profile ? identitiesDir(profile) : '<profile>/botfactory/identities'
  const groups = identity.scope.groups.map(group => group.name ? `${group.chatId}（${group.name}）` : group.chatId)
  return [
    `校验通过：${identity.name}（${identity.id}）`,
    'BotFather 在这一个机器人的私聊里开线，不会新开 BotID。权限先不做。',
    `私聊：${identity.scope.directMessages ? '开' : '这条线不占私聊'}。群：${groups.length ? groups.join('、') : '无'}。`,
    `写入 ${dir}/${identity.id}.yml`,
    `写入 ${profile ? join(profile, 'botfactory', 'companions', `${identity.id}.md`) : '<profile>/botfactory/companions/' + identity.id + '.md'}`,
    `招呼：${identity.smoke}`,
  ]
}

/**
 * Validates an identity file and, unless `--dry-run`, writes the profile fragments and asks the running panel to
 * listen on those chats. Direct messages are turned on because BotFather lives there.
 */
export async function runBotfactory(options: WireOptions): Promise<number> {
  const env = options.env ?? process.env
  const log = options.log ?? (line => { console.log(line) })
  const error = options.error ?? (line => { console.error(line) })
  try {
    const args = parseArgs(options.argv)
    if (args.help) { log(usage()); return 0 }
    if (!args.file && !args.init) { error(usage()); return 1 }
    const identity = args.file ? parseIdentityFile(readFileSync(args.file, 'utf8')) : undefined
    const profile = profileDir(args.profile, env, options.home ?? homedir())
    const lines = [
      ...identity ? describe(identity, profile) : ['准备 BotFather 的私聊入口。还是这一个机器人。'],
      profile ? `配置目录：${profile}` : '这台机器上还没有 superagent 的 cordis.patch.yml。',
    ]
    if (args.dryRun) {
      for (const line of lines) log(line)
      log('干跑，没有写文件，也没有改企业微信设置。')
      return 0
    }
    if (!profile) { error('找不到配置目录。用 --profile 指到有 cordis.patch.yml 的目录。'); return 1 }
    const patchPath = join(profile, 'cordis.patch.yml')
    if (!existsSync(patchPath)) { error('配置目录里没有 cordis.patch.yml。'); return 1 }
    const dir = identitiesDir(profile)
    if (identity) {
      const conflict = chatConflict(loadIdentities(dir), identity)
      if (conflict) { error(`${conflict}。`); return 1 }
    }
    ensureRoute(dir)
    if (identity) openFactory(dir).saveIdentity(identity)
    const patch = readFileSync(patchPath, 'utf8')
    const next = enableWecomPlugin(patch)
    if (next !== patch) writeFileSync(patchPath, next)
    const identities = loadIdentities(dir)
    const status = await pushWecomSettings(dir, identities, options.fetch ?? fetch)
    for (const line of lines) log(scrub(line, env))
    log(scrub(status, env))
    log(next === patch ? '企业微信插件本来就是开的。' : '已在 cordis.patch.yml 里打开企业微信插件。改插件开关要重启一次。')
    return 0
  } catch (cause) {
    error(scrub(cause instanceof Error ? cause.message : '接线失败', env))
    return 1
  }
}
