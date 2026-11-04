/** BotFather grill, identity files, and the dry-run wire onto one WeCom bot. */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { planCompanion } from '../src/botfactory/companion.ts'
import { botfatherTurn, chatConflict, smokeFor } from '../src/botfactory/grill.ts'
import { BotfatherRouteSchema, type GrillDraft } from '../src/botfactory/schema.ts'
import { scrub } from '../src/botfactory/secrets.ts'
import { enableWecomPlugin, mergeFeishuConfig, mergeWecomConfig, webPort } from '../src/botfactory/settings.ts'
import { loadIdentities, openFactory, parseIdentityFile } from '../src/botfactory/store.ts'
import { runBotfactory } from '../src/botfactory/wire.ts'
import { parseYaml } from '../src/botfactory/yaml.ts'
import { checkedImText } from '../src/infra/text.ts'
import { feishuKind } from '../src/sources/feishu.ts'
import { queueWecomCompanion, wecomKind } from '../src/sources/wecom.ts'
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

describe('BotFather grill', () => {
  it('asks one question at a time in a direct message and wires a line without a group mention', () => {
    const identities = [] as ReturnType<typeof loadIdentities>
    const steps = [
      '新建业务线 trade-followup 外贸跟单伴侣',
      '你是跟单同事，用口语帮人盯客户、订单和到账。',
      '只私聊',
      '打招呼、问进度',
      '跟单、催办、到账确认',
      '改价格、承诺交期',
      '跟单同事',
      '外贸负责人 ZhangSan',
      '不接',
      '在的。跟单、催办、到账确认直接说就行。',
      '就这样',
    ]
    let turn = botfatherTurn({ direct: true, userid: 'boss', text: steps[0]!, route: { ok: true, operators: [] }, draft: undefined, identities })
    for (const text of steps.slice(1)) {
      expect(turn.handled).toBe(true)
      if (!turn.handled) return
      checkedSpeech(turn.text)
      turn = botfatherTurn({ direct: true, userid: 'boss', text, route: { ok: true, operators: [] }, draft: turn.draft ?? undefined, identities })
    }
    expect(turn.handled).toBe(true)
    if (!turn.handled || !turn.wired) throw new Error('expected a wired line')
    checkedSpeech(turn.text)
    expect(turn.text).toContain('不用先在群里')
    expect(turn.wired).toMatchObject({
      id: 'trade-followup', name: '外贸跟单伴侣', permissions: 'deferred',
      scope: { directMessages: true, otherChats: 'none', groups: [] }, erp: { enabled: false },
    })
    expect(chatConflict([{ ...turn.wired, id: 'other', scope: { directMessages: false, otherChats: 'none', groups: [{ chatId: 'wr_trade' }] } }],
      { ...turn.wired, scope: { directMessages: true, otherChats: 'none', groups: [{ chatId: 'wr_trade' }] } })).toMatch(/wr_trade/)
  })

  it('hears a follow-up colleague and an open range, then moves on without repeating itself', () => {
    const route = { ok: true, operators: [] } as const
    const identities = [] as ReturnType<typeof loadIdentities>
    const say = (text: string, draft?: GrillDraft | null) => {
      const turn = botfatherTurn({ direct: true, userid: 'boss', text, route, draft: draft ?? undefined, identities })
      expect(turn.handled).toBe(true)
      if (!turn.handled) throw new Error('expected a factory turn')
      checkedSpeech(turn.text)
      return turn
    }
    let turn = say('新建业务线')
    expect(turn.text).toContain('这条线叫什么')
    turn = say('就叫跟单吧', turn.draft)
    expect(turn.draft?.name).toBe('跟单')
    expect(turn.draft?.slot).toBe('persona')
    const personaAsk = turn.text
    turn = say('嗯', turn.draft)
    expect(turn.draft?.slot).toBe('persona')
    expect(turn.text).not.toBe(personaAsk)
    turn = say('他是我们的跟单同事', turn.draft)
    expect(turn.text).not.toBe(personaAsk)
    expect(turn.text).not.toContain('它是谁')
    expect(turn.draft).toMatchObject({ slot: 'scope', persona: '他是我们的跟单同事' })
    const scopeAsk = turn.text
    turn = say('再说吧', turn.draft)
    expect(turn.draft?.slot).toBe('scope')
    expect(turn.text).not.toBe(scopeAsk)
    expect(turn.text).toContain('只私聊')
    expect(turn.text).toContain('指定群')
    expect(turn.text).toContain('所有已接入')
    const scopeNudge = turn.text
    turn = say('再说吧', turn.draft)
    expect(turn.text).not.toBe(scopeNudge)
    expect(turn.text).not.toBe(scopeAsk)
    expect(turn.draft?.slot).toBe('scope')
    for (const text of ['它open的，所有群里面都行', 'open', 'OPEN', '全员', '所有群里面都行', '到处都能说', '不限群']) {
      const heard = say(text, { slot: 'scope', id: 'line-1', name: '跟单', persona: '他是我们的跟单同事' })
      expect(heard.text).not.toBe(scopeAsk)
      expect(heard.text).not.toContain('它在哪说话')
      expect(heard.text).toContain('直接回')
      expect(heard.draft).toMatchObject({ slot: 'autoReply', directMessages: true, otherChats: 'mentions', groups: [] })
    }
    turn = say('它open的，所有群里面都行', turn.draft)
    expect(turn.draft?.slot).toBe('autoReply')
    const replyAsk = turn.text
    turn = say('就这些', turn.draft)
    expect(turn.text).not.toBe(replyAsk)
    expect(turn.draft).toMatchObject({ slot: 'autoAdvance', autoReply: ['打招呼', '问进度'] })
    const listed = say('打招呼和问进度', { slot: 'autoReply', id: 'line-1', name: '跟单', persona: '他是我们的跟单同事' })
    expect(listed.draft?.autoReply).toEqual(['打招呼', '问进度'])
    turn = say('就这些', turn.draft)
    turn = say('就这些', turn.draft)
    expect(turn.draft).toMatchObject({ humanApprove: ['改价格', '承诺交期'], slot: 'formatter' })
    turn = say('它自己', turn.draft)
    expect(turn.draft).toMatchObject({ formatter: '跟单同事', slot: 'escalation' })
    turn = say('就他', turn.draft)
    expect(turn.draft?.escalation).toEqual([{ name: '外贸负责人' }])
    turn = say('先不接', turn.draft)
    expect(turn.draft?.erp).toEqual({ enabled: false })
    turn = say('你写', turn.draft)
    expect(turn.draft?.smoke).toBe('在的。我是跟单同事。')
    expect(turn.text).toContain('所有已接入')
    const summary = turn.text
    turn = say('不对', turn.draft)
    expect(turn.text).not.toBe(summary)
    expect(turn.draft?.slot).toBe('confirm')
    turn = say('不对', turn.draft)
    expect(turn.text).not.toBe(summary)
    turn = say('可以', turn.draft)
    expect(turn.wired).toMatchObject({
      name: '跟单', persona: '他是我们的跟单同事', permissions: 'deferred',
      scope: { directMessages: true, otherChats: 'mentions', groups: [] },
      formatter: '跟单同事', smoke: '在的。我是跟单同事。',
    })
    expect(turn.text).toContain('所有已接入')
    expect(turn.text).not.toMatch(/闸门|呈报/)
    if (!turn.wired) throw new Error('expected a wired line')
    expect(smokeFor([turn.wired], false, 'wr_anywhere')).toBe('在的。我是跟单同事。')
    const named = say('私聊，群 wr_trade，还有 oc_room', { slot: 'scope', name: '跟单', persona: '他是我们的跟单同事' })
    expect(named.draft).toMatchObject({
      slot: 'autoReply', directMessages: true, otherChats: 'none',
      groups: [{ chatId: 'wr_trade' }, { chatId: 'oc_room' }],
    })
    const first = say('第一个', { slot: 'scope', name: '跟单', persona: '他是我们的跟单同事' })
    expect(first.draft).toMatchObject({ slot: 'autoReply', directMessages: true, otherChats: 'none', groups: [] })
    const third = say('第三个', { slot: 'scope', name: '跟单', persona: '他是我们的跟单同事' })
    expect(third.draft).toMatchObject({ slot: 'autoReply', directMessages: true, otherChats: 'mentions', groups: [] })
    const picked = say('指定群', { slot: 'scope', name: '跟单', persona: '他是我们的跟单同事' })
    expect(picked.draft?.slot).toBe('scope')
    expect(picked.draft?.listenFor).toBe('group-id')
    expect(picked.text).toContain('wr_')
    expect(picked.text).not.toContain('它在哪说话')
    const alongside = say('他是我们的跟单同事，所有群里面都行', { slot: 'persona', id: 'line-1', name: '跟单' })
    expect(alongside.draft).toMatchObject({
      slot: 'autoReply', persona: '他是我们的跟单同事', directMessages: true, otherChats: 'mentions',
    })
    const erp = say('接 Odoo，以 crm.lead 为准，写 phone', {
      slot: 'erp', id: 'line-1', name: '跟单', persona: '他是我们的跟单同事',
      directMessages: true, otherChats: 'mentions', groups: [],
      autoReply: ['打招呼'], autoAdvance: ['跟单'], humanApprove: ['改价格'],
      formatter: '跟单同事', escalation: [{ name: '外贸负责人' }],
    })
    expect(erp.draft?.slot).toBe('smoke')
    expect(erp.draft?.erp).toMatchObject({ enabled: true, write: ['phone'] })
  })

  it('stays off in groups and for a userid outside the factory route', () => {
    const group = wecomTrigger({ body: { msgid: 'g1', chatid: 'wr_trade', chattype: 'group', from: { userid: 'boss' }, msgtype: 'text', text: { content: '新建业务线' } } }, NOW)!
    expect(planCompanion(group, undefined)?.text).not.toContain('这条线叫什么')
    expect(botfatherTurn({ direct: true, userid: 'bob', text: '新建业务线', route: { ok: true, operators: ['alice'] }, draft: undefined, identities: [] }).handled).toBe(false)
    expect(botfatherTurn({ direct: false, userid: 'boss', text: '新建业务线', route: { ok: true, operators: [] }, draft: undefined, identities: [] }).handled).toBe(false)
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

  it('queues a BotFather question for a direct message and keeps an ordinary greeting', () => {
    const root = temp()
    const dir = join(root, 'identities')
    const library = openFactory(dir)
    const notices: { text: string }[] = []
    const ctx = { notify: (message: { text: string }) => { notices.push(message) }, outboundStatus: () => undefined }
    queueWecomCompanion(ctx, dm('新建业务线', 'boss', 'a'), 'stored', dir)
    expect(checkedSpeech(notices[0]?.text ?? '')).toContain('这条线叫什么')
    expect(library.draft('boss')?.slot).toBe('name')
    queueWecomCompanion(ctx, dm('你好', 'boss', 'c'), 'filtered', dir)
    expect(notices).toHaveLength(1)
    queueWecomCompanion(ctx, dm('你好', 'other', 'd'), 'stored')
    expect(notices[1]?.text).not.toContain('这条线叫什么')
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

  it('sends the factory question on a Feishu direct message and stays quiet for ordinary chat', () => {
    const dir = join(temp(), 'identities')
    const library = openFactory(dir)
    const started = planCompanion(feishuDm('新建业务线'), library)
    expect(checkedSpeech(started?.text ?? '')).toContain('这条线叫什么')
    started?.commit?.()
    expect(library.draft('feishu-ou_boss')?.slot).toBe('name')
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
