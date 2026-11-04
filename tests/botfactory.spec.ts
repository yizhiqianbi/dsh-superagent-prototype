/** BotFather's session handoff, identity files, and the dry-run wire onto one WeCom bot. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { composePrompt, defaultPrompts } from '../src/app/prompts.ts'
import { planCompanion } from '../src/botfactory/companion.ts'
import { FACTORY_STOP, ROUTE_BROKEN, smokeFor } from '../src/botfactory/grill.ts'
import { applyBotfather, factoryHandoff } from '../src/botfactory/harness.ts'
import { BotfatherRouteSchema, type BusinessIdentity } from '../src/botfactory/schema.ts'
import { scrub } from '../src/botfactory/secrets.ts'
import { enableWecomPlugin, mergeFeishuConfig, mergeWecomConfig, webPort } from '../src/botfactory/settings.ts'
import { loadIdentities, openFactory, parseIdentityFile } from '../src/botfactory/store.ts'
import { runBotfactory } from '../src/botfactory/wire.ts'
import { parseYaml } from '../src/botfactory/yaml.ts'
import { checkedImText } from '../src/infra/text.ts'
import { SettingsSchema } from '../src/policy.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { queueWecomCompanion, wecomKind } from '../src/sources/wecom.ts'
import { WECOM_GREETING, WECOM_RECEIVED } from '../src/sources/wecom-channel.ts'
import { wecomTrigger } from '../src/sources/wecom-trigger.ts'
import type { Trigger } from '../src/core/index.ts'

const NOW = '2026-11-04T03:00:00.000Z'
const EXAMPLE = join(import.meta.dirname, '../examples/botfactory/trade-followup.yml')
const dirs: string[] = []
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }) })

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'botfactory-'))
  dirs.push(dir)
  return dir
}

function dm(text: string, userid = 'boss', msgid = text) {
  return wecomTrigger({ body: { msgid, chattype: 'single', from: { userid }, msgtype: 'text', text: { content: text } } }, NOW)!
}

function checkedSpeech(text: string): string {
  expect(text).not.toMatch(/闸门|呈报/)
  return checkedImText(text)
}

function example(): BusinessIdentity {
  return parseIdentityFile(readFileSync(EXAMPLE, 'utf8'))
}

describe('BotFather session', () => {
  it('leaves a direct message that opens a line to the session, and keeps talking', () => {
    const root = temp()
    const dir = join(root, 'identities')
    const library = openFactory(dir)
    const started = planCompanion(dm('新建业务线'), library)
    expect(started?.harness).toBe(true)
    expect(started?.text).toBeUndefined()
    started?.commit?.()
    expect(library.draft('boss')?.lines).toEqual([{ role: 'user', text: '新建业务线' }])
    const next = planCompanion(dm('不接 Odoo，工作台当 ERP', 'boss', 'b'), library)
    expect(next?.harness).toBe(true)
    expect(next?.text).toBeUndefined()
    next?.commit?.()
    expect(library.draft('boss')?.lines.map(line => line.text)).toEqual(['新建业务线', '不接 Odoo，工作台当 ERP'])
    const settings = SettingsSchema.parse({ sources: { wecom: { enabled: true, config: { identitiesDir: dir } } } })
    expect(factoryHandoff(settings, dm('不接 Odoo，工作台当 ERP', 'boss', 'b'))?.lines.at(-1)?.text).toBe('不接 Odoo，工作台当 ERP')
    expect(factoryHandoff(SettingsSchema.parse({}), dm('新建业务线'))).toBeUndefined()
  })

  it('keeps a picture with the words and does not answer that turn itself', () => {
    const dir = join(temp(), 'identities')
    const library = openFactory(dir)
    const shot = wecomTrigger({ body: { msgid: 'img', chattype: 'single', from: { userid: 'boss' }, msgtype: 'mixed', mixed: { msg_item: [
      { msgtype: 'image', image: { url: 'https://example.invalid/sop', aeskey: 'secret-key' } },
      { msgtype: 'text', text: { content: '新建业务线' } },
      { msgtype: 'text', text: { content: '外贸跟单 SOP' } },
    ] } } }, NOW)!
    expect(shot.text).not.toContain('secret-key')
    expect(shot.text).not.toContain('example.invalid')
    const notices: { text: string }[] = []
    const ctx = { notify: (message: { text: string }) => { notices.push(message) }, outboundStatus: () => undefined }
    queueWecomCompanion(ctx, shot, 'stored', dir)
    expect(notices).toEqual([])
    expect(library.draft('boss')?.lines[0]?.text).toBe('[图片 wximg_1]\n新建业务线\n外贸跟单 SOP')
    const later = wecomTrigger({ body: { msgid: 'img2', chattype: 'single', from: { userid: 'boss' }, msgtype: 'image',
      image: { url: 'https://example.invalid/b', aeskey: 'k2' } } }, NOW)!
    const next = planCompanion(later, library)
    expect(next?.harness).toBe(true)
    expect(next?.text).toBeUndefined()
  })

  it('does not post a question, and an ordinary greeting stays a greeting', () => {
    const root = temp()
    const dir = join(root, 'identities')
    const library = openFactory(dir)
    const notices: { text: string }[] = []
    const ctx = { notify: (message: { text: string }) => { notices.push(message) }, outboundStatus: () => undefined }
    queueWecomCompanion(ctx, dm('新建业务线', 'boss', 'a'), 'stored', dir)
    expect(notices).toEqual([])
    expect(library.draft('boss')?.lines[0]?.text).toBe('新建业务线')
    queueWecomCompanion(ctx, dm('你好', 'boss', 'c'), 'filtered', dir)
    expect(notices).toEqual([])
    queueWecomCompanion(ctx, dm('你好', 'other', 'd'), 'stored')
    expect(notices.map(notice => notice.text)).toEqual([WECOM_GREETING])
  })

  it('stays off in groups, for someone outside the route, and when the route file will not parse', () => {
    const root = temp()
    const dir = join(root, 'identities')
    const library = openFactory(dir)
    const group = wecomTrigger({ body: { msgid: 'g1', chatid: 'wr_trade', chattype: 'group', from: { userid: 'boss' }, msgtype: 'text', text: { content: '新建业务线' } } }, NOW)!
    expect(planCompanion(group, library)?.harness).toBeUndefined()
    expect(planCompanion(group, library)?.text).toBe(WECOM_RECEIVED)
    writeFileSync(join(root, 'botfather.yml'), 'id: botfather\nname: BotFather\nroute: dm\noperators:\n  - alice\n')
    const closed = openFactory(dir)
    expect(planCompanion(dm('新建业务线', 'bob'), closed)?.harness).toBeUndefined()
    expect(planCompanion(dm('新建业务线', 'bob'), closed)?.text).toBe(WECOM_RECEIVED)
    writeFileSync(join(root, 'botfather.yml'), 'nope: [\n')
    expect(planCompanion(dm('新建业务线'), openFactory(dir))?.text).toBe(ROUTE_BROKEN)
  })

  it('drops an open conversation on an exact stop, and still asks to init when nothing is wired', () => {
    const dir = join(temp(), 'identities')
    const library = openFactory(dir)
    library.saveDraft('boss', { open: true, lines: [{ role: 'user', text: '新建业务线' }] })
    const stopped = planCompanion(dm('取消', 'boss', 'x'), library)
    expect(stopped?.text).toBe(FACTORY_STOP)
    expect(stopped?.harness).toBeUndefined()
    stopped?.commit?.()
    expect(library.draft('boss')).toBeUndefined()
    expect(planCompanion(dm('新建业务线'), undefined)?.text).toContain('--init')
  })

  it('writes the session\'s own words with the template, and a later template replaces the line', () => {
    const dir = join(temp(), 'identities')
    const library = openFactory(dir)
    const identity = example()
    const first = applyBotfather(library, 'boss', { text: '先记着，Odoo 开着。', identity })
    expect(first.say).toBe('先记着，Odoo 开着。')
    expect(first.wired?.id).toBe('trade-followup')
    expect(library.draft('boss')).toBeUndefined()
    const said = '这条线是外贸跟单。私聊和外贸跟单群。Odoo 先不接。'
    const second = applyBotfather(library, 'boss', { text: said, identity: { ...identity, erp: { enabled: false } } })
    expect(second.say).toBe(said)
    expect(second.say).not.toContain('这些我来排班')
    expect(loadIdentities(dir)[0]?.erp).toEqual({ enabled: false })
  })

  it('refuses an unfinished template and a group another line owns', () => {
    const dir = join(temp(), 'identities')
    const library = openFactory(dir)
    library.saveDraft('boss', { open: true, lines: [{ role: 'user', text: '新建业务线' }] })
    const identity = example()
    const { persona: _persona, ...rest } = identity
    const missing = applyBotfather(library, 'boss', { text: '还没齐。', identity: rest })
    expect(missing.error).toMatch(/persona/)
    expect(missing.say).toBeUndefined()
    expect(loadIdentities(dir)).toEqual([])
    expect(library.draft('boss')?.open).toBe(true)
    library.saveIdentity(identity)
    const conflict = applyBotfather(library, 'boss', {
      text: '换一条。', identity: { ...identity, id: 'other-line', name: '另一条' },
    })
    expect(conflict.error).toMatch(/wr_trade/)
    expect(loadIdentities(dir).map(item => item.id)).toEqual(['trade-followup'])
  })

  it('derives an id, forces deferred permissions, and will not send a line that is too long', () => {
    const dir = join(temp(), 'identities')
    const library = openFactory(dir)
    const identity = example()
    const { id: _id, ...named } = identity
    const dirty: Record<string, unknown> = { ...named, permissions: 'allow', extra: true }
    const wired = applyBotfather(library, 'boss', { text: '好。', identity: dirty })
    expect(wired.wired?.id).toMatch(/^line-[0-9a-f]{8}$/)
    expect(wired.wired?.permissions).toBe('deferred')
    expect(readFileSync(join(dir, `${wired.wired?.id}.yml`), 'utf8')).not.toContain('extra')
    library.saveDraft('boss', { open: true, lines: [{ role: 'user', text: '新建业务线' }] })
    const long = applyBotfather(library, 'boss', { text: Array.from({ length: 101 }, () => 'word').join(' '), close: true })
    expect(long.error).toMatch(/100/)
    expect(library.draft('boss')?.open).toBe(true)
    expect(applyBotfather(library, 'boss', {}).error).toMatch(/Say something/)
  })

  it('uses one line\'s smoke for a direct chat and for every connected group', () => {
    const identity = example()
    expect(smokeFor([identity], true, 'anywhere')).toBe(identity.smoke)
    expect(smokeFor([identity], false, 'wr_trade')).toBe(identity.smoke)
    expect(smokeFor([identity], false, 'wr_other')).toBeUndefined()
    const open = { ...identity, scope: { directMessages: true, otherChats: 'mentions' as const, groups: [] } }
    expect(smokeFor([open], false, 'wr_other')).toBe(identity.smoke)
    expect(checkedSpeech(identity.smoke)).toBe(identity.smoke)
  })

  it('tells only the orchestrator to call botfather', () => {
    expect(composePrompt(defaultPrompts(), 'orchestrator')).toContain('call botfather')
    expect(composePrompt(defaultPrompts(), 'orchestrator')).toContain('Read the image')
    expect(composePrompt(defaultPrompts(), 'worker')).not.toContain('call botfather')
  })
})

describe('identity files', () => {
  it('parses the example line and round-trips YAML', () => {
    const text = readFileSync(EXAMPLE, 'utf8')
    expect(text).not.toMatch(/WECOM_BOT_SECRET|闸门|呈报/)
    const identity = parseIdentityFile(text)
    expect(identity.name).toBe('外贸跟单伴侣')
    expect(identity.erp).toMatchObject({ enabled: true, adapter: 'odoo', write: ['phone', 'email_from', 'contact_name'] })
    expect(parseYaml(readFileSync(join(import.meta.dirname, '../examples/botfactory/botfather.yml'), 'utf8'))).toMatchObject({ route: 'dm', operators: [] })
    expect(BotfatherRouteSchema.parse(parseYaml(readFileSync(join(import.meta.dirname, '../examples/botfactory/botfather.yml'), 'utf8'))).operators).toEqual([])
    const dir = temp()
    const identities = join(dir, 'botfactory', 'identities')
    const library = openFactory(identities)
    library.saveIdentity(identity)
    expect(loadIdentities(identities)).toEqual([identity])
    expect(readFileSync(join(dir, 'botfactory', 'companions', 'trade-followup.md'), 'utf8')).toContain('需要你拍板')
    const config = wecomKind.schema.parse({ identitiesDir: identities, chats: [], directMessages: true })
    expect(wecomKind.scope!({ meta: { chatId: 'wr_trade', direct: false } }, config)).toEqual({ listened: true, observed: false, row: 'wr_trade' })
    expect(wecomKind.policy!.rows!(config).map(row => row.id)).toContain('wr_trade')
  })

  it('refuses a secret in the identity file', () => {
    expect(() => parseIdentityFile('secret: super-secret\n')).toThrow(/Secret/)
    expect(scrub('token super-secret', { WECOM_BOT_SECRET: 'super-secret' })).toBe('token [redacted]')
  })
})

describe('botfactory-wire', () => {
  it('dry-run prints the smoke line and writes nothing', async () => {
    const home = temp()
    const lines: string[] = []
    const code = await runBotfactory({ argv: ['--dry-run', EXAMPLE], env: {}, home, log: line => { lines.push(line) } })
    expect(code).toBe(0)
    expect(lines.join('\n')).toContain('在的。跟单、催办、到账确认')
    expect(lines.join('\n')).toContain('干跑')
    expect(lines.join('\n')).not.toMatch(/闸门|WECOM_BOT_SECRET/)
  })

  it('writes the profile fragments and enables the existing WeCom plugin', async () => {
    const profile = temp()
    const patch = '- id: webserver\n  config:\n    port: 3099\n- id: dsh-superagent-wecom\n  disabled: true\n'
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
    const lines: string[] = []
    const code = await runBotfactory({
      argv: ['--profile', profile, EXAMPLE], env: {}, home: temp(), log: line => { lines.push(line) },
      fetch: async () => new Response('no', { status: 503 }),
    })
    expect(code).toBe(0)
    expect(readFileSync(join(profile, 'cordis.patch.yml'), 'utf8')).toContain('id: dsh-superagent-wecom\n  disabled: false')
    expect(loadIdentities(join(profile, 'botfactory', 'identities'))[0]?.id).toBe('trade-followup')
    expect(lines.join('\n')).toContain('面板没有返回设置')
    expect(enableWecomPlugin('x\n')).toContain('disabled: false')
    expect(webPort(patch)).toBe(3099)
    expect(mergeWecomConfig({ botId: 'bot-1', secret: 'nope', chats: [] }, '/tmp/identities', loadIdentities(join(profile, 'botfactory', 'identities')))).toMatchObject({
      botId: 'bot-1', directMessages: true, identitiesDir: '/tmp/identities',
      chats: [{ chatId: 'wr_trade', name: '外贸跟单群' }],
    })
    expect(mergeWecomConfig({ secret: 'nope' }, '/tmp/identities', [])).not.toHaveProperty('secret')
  })
})

describe('Feishu on the same identity', () => {
  function feishuDm(text: string, msgid = 'm'): Trigger {
    return {
      id: `feishu:${msgid}`, source: 'feishu', threads: [{ source: 'feishu', id: 'oc_dm:m' }],
      actor: { source: 'feishu', id: 'ou_boss' }, human: true, addressed: 'direct', at: NOW, text,
      channel: { source: 'feishu', thread: 'feishu:oc_dm', address: { chatId: 'oc_dm', messageId: msgid, direct: 'true' } },
      meta: { chatId: 'oc_dm', messageId: msgid, direct: true },
    }
  }

  it('keeps a Feishu direct message in its own conversation and stays quiet for ordinary chat', () => {
    const dir = join(temp(), 'identities')
    const library = openFactory(dir)
    const started = planCompanion(feishuDm('新建业务线'), library)
    expect(started?.harness).toBe(true)
    expect(started?.text).toBeUndefined()
    started?.commit?.()
    expect(library.draft('feishu-ou_boss')?.open).toBe(true)
    expect(library.draft('ou_boss')).toBeUndefined()
    const quiet = openFactory(join(temp(), 'identities'))
    expect(planCompanion(feishuDm('有业务', 'n'), quiet)).toBeUndefined()
    expect(planCompanion(feishuDm('新建业务线', 'o'), undefined)?.text).toContain('--init')
  })

  it('splits oc_ chats onto Feishu and leaves the Feishu CLI alone', () => {
    const identity = parseIdentityFile(readFileSync(EXAMPLE, 'utf8'))
    const mixed = { ...identity, scope: { ...identity.scope, groups: [...identity.scope.groups, { chatId: 'oc_trade', name: '飞书群' }] } }
    const dir = join(temp(), 'identities')
    openFactory(dir).saveIdentity(mixed)
    const wecom = wecomKind.schema.parse({ identitiesDir: dir, chats: [], directMessages: true })
    const feishu = feishuKind.schema.parse({ identitiesDir: dir, cli: '/Users/pencil/.local/bin/lark-bot', directMessages: true, otherChats: 'mentions' })
    expect(wecomKind.scope!({ meta: { chatId: 'wr_trade', direct: false } }, wecom).listened).toBe(true)
    expect(wecomKind.scope!({ meta: { chatId: 'oc_trade', direct: false } }, wecom).listened).toBe(false)
    expect(feishuKind.scope!({ meta: { chatId: 'oc_trade', direct: false } }, feishu)).toMatchObject({ listened: true, row: 'oc_trade' })
    expect(mergeWecomConfig({ chats: [] }, dir, [mixed]).chats).toEqual([{ chatId: 'wr_trade', name: '外贸跟单群' }])
    expect(mergeFeishuConfig({ cli: '/Users/pencil/.local/bin/lark-bot', otherChats: 'mentions', chats: [{ chatId: 'oc_old', listen: 'all' }] }, dir, [mixed])).toMatchObject({
      cli: '/Users/pencil/.local/bin/lark-bot', otherChats: 'mentions', directMessages: true,
      chats: [{ chatId: 'oc_old', listen: 'all' }, { chatId: 'oc_trade', name: '飞书群', listen: 'mentions' }],
    })
    const wired = planCompanion(feishuDm('你好'), openFactory(dir))
    expect(wired?.text).toBe(identity.smoke)
  })
})
