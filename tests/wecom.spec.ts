/** WeCom Source: frame translation, gate-card framing, configuration, and the long-connection loop without live credentials. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WSAuthFailureError } from '@wecom/aibot-node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { checkedImText } from '../src/infra/text.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { WECOM_GREETING, WECOM_RECEIVED, sendWecom, wecomCompanionNotice, wecomCompanionText, wecomGone, wecomLink, wecomOutbound, wecomTaskId, type WecomOutbound } from '../src/sources/wecom-channel.ts'
import { wecomThreadContext } from '../src/sources/wecom-read.ts'
import { acquireWecomBot, bindWecomSend, resetWecomRuntime, setWecomSocketFactory, type WecomSocket } from '../src/sources/wecom-socket.ts'
import { apply as applyWecom, queueWecomCompanion, runWecomSession, watchWecom, WECOM_CREDENTIALS, wecomCredentials, wecomKind, wecomRetry } from '../src/sources/wecom.ts'
import { wecomTime, wecomTrigger } from '../src/sources/wecom-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const NOW = '2026-11-04T03:00:00.000Z'
const saved = { ...process.env }
const stops: AbortController[] = []
const running: Promise<unknown>[] = []

class FakeSocket implements WecomSocket {
  readonly handlers = new Map<string, ((payload: unknown) => void)[]>()
  readonly sent: { chatId: string; body: WecomOutbound }[] = []
  connected = false
  closed = false
  fail: unknown
  on(event: string, handler: (payload: unknown) => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), handler])
  }
  connect(): void { this.connected = true }
  disconnect(): void { this.closed = true; this.connected = false }
  emit(event: string, payload?: unknown): void {
    for (const handler of this.handlers.get(event) ?? []) handler(payload)
  }
  sendMessage(chatId: string, body: WecomOutbound): Promise<unknown> {
    if (this.fail) return Promise.reject(this.fail)
    this.sent.push({ chatId, body })
    return Promise.resolve({ errcode: 0, errmsg: 'ok' })
  }
}

afterEach(async () => {
  for (const stop of stops) stop.abort()
  await Promise.all(running.splice(0))
  stops.length = 0
  resetWecomRuntime()
  for (const name of ['WECOM_BOT_ID', 'WECOM_BOT_SECRET', 'WECOM_SECRET_FILE']) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function track<T>(promise: Promise<T>, stop = new AbortController()): Promise<T> {
  stops.push(stop)
  running.push(promise.catch(() => {}))
  return promise
}

function host(enabled = true) {
  const directory = mkdtempSync(join(tmpdir(), 'wecom-'))
  const store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    eval: { mode: 'auto' },
    sources: { wecom: { enabled, config: { chats: [{ chatId: 'wr_team', name: '老板群' }], directMessages: true, otherChats: 'none' } } },
    policy: { sources: { wecom: { allowed: [{ id: 'boss', name: '老板' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(wecomKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const deployment = testDeployment()
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) }, status: id => store.receipts.get(id)?.status }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  const close = () => { store.close(); rmSync(directory, { recursive: true, force: true }) }
  return { store, engine, sources, receive, health: board.all, ctx: sourceContextOf(deps, wecomKind), close, deps }
}

function textFrame(fields: Record<string, unknown> = {}) {
  return { cmd: 'aibot_msg_callback', headers: { req_id: 'req-1' }, body: {
    msgid: 'msg-1', aibotid: 'bot-1', chatid: 'wr_team', chattype: 'group', from: { userid: 'boss' },
    msgtype: 'text', text: { content: '可以合并' }, ...fields,
  } }
}

describe('wecom frames', () => {
  it('maps a group mention, a direct message, a voice transcript, mixed text and a card click', () => {
    const group = wecomTrigger(textFrame(), NOW)
    expect(group).toMatchObject({
      id: key('wecom', 'msg-1'), source: 'wecom', threads: [{ source: 'wecom', id: 'wr_team' }],
      actor: { source: 'wecom', id: 'boss' }, human: true, addressed: 'mention', at: NOW, text: '可以合并',
      channel: { source: 'wecom', thread: 'wecom:wr_team', address: { chatId: 'wr_team', messageId: 'msg-1', chatType: 'group' } },
      meta: { chatId: 'wr_team', chatType: 'group', messageId: 'msg-1', direct: false, mentioned: true, userid: 'boss' },
    })
    expect(wecomTrigger(textFrame(), NOW)?.id).toBe(group?.id)
    const direct = wecomTrigger(textFrame({ chatid: undefined, chattype: 'single', create_time: 1_700_000_000 }), NOW)
    expect(direct).toMatchObject({
      addressed: 'direct', at: wecomTime(1_700_000_000, NOW),
      threads: [{ source: 'wecom', id: 'dm:boss' }],
      channel: { address: { chatId: 'boss', chatType: 'single' } },
      meta: { direct: true, chatId: 'boss' },
    })
    expect(wecomTrigger(textFrame({ msgtype: 'voice', text: undefined, voice: { content: '合并' } }), NOW)?.text).toBe('合并')
    expect(wecomTrigger(textFrame({ msgtype: 'mixed', text: undefined, mixed: { msg_item: [
      { msgtype: 'text', text: { content: '看一下' } }, { msgtype: 'image', image: { url: 'https://example.invalid/a' } },
      { msgtype: 'text', text: { content: '再决定' } },
    ] } }), NOW)?.text).toBe('看一下\n再决定')
    const click = wecomTrigger({ body: { msgid: 'evt-1', create_time: 1_700_000_000, chatid: 'wr_team', chattype: 'group',
      from: { userid: 'boss' }, msgtype: 'event', event: { eventtype: 'template_card_event', event_key: '① 合并', task_id: 'task-1' } } }, NOW)
    expect(click).toMatchObject({ text: '① 合并', addressed: 'mention', meta: { eventKey: '① 合并', taskId: 'task-1' } })
  })

  it('drops images, session entry, the bot itself, assistant callbacks and a group event with no chat', () => {
    expect(wecomTrigger(textFrame({ msgtype: 'image', text: undefined, image: { url: 'https://example.invalid/a', aeskey: 'k' } }), NOW)).toBeUndefined()
    expect(wecomTrigger({ body: { msgid: 'evt-2', from: { userid: 'boss' }, msgtype: 'event', event: { eventtype: 'enter_chat' } } }, NOW)).toBeUndefined()
    expect(wecomTrigger(textFrame({ from: { userid: 'bot-1' } }), NOW)).toBeUndefined()
    expect(wecomTrigger(textFrame({ compat_info: { source: 'ai_assistant' } }), NOW)).toBeUndefined()
    expect(wecomTrigger(textFrame({ chattype: 'group', chatid: undefined }), NOW)).toBeUndefined()
    expect(wecomTrigger({ body: { msgid: '' } }, NOW)).toBeUndefined()
    expect(wecomTime(Number.NaN, NOW)).toBe(NOW)
  })
})

describe('wecom settings', () => {
  it('keeps the secret out of settings and listens to listed chats, other mentions and direct messages', () => {
    expect(wecomKind.schema.parse({})).toEqual({ botId: '', secretEnv: 'WECOM_BOT_SECRET', chats: [], directMessages: true, otherChats: 'none', identitiesDir: '' })
    expect(() => wecomKind.schema.parse({ secret: 'nope' })).toThrow()
    expect(() => wecomKind.schema.parse({ secretEnv: 'bot_secret' })).toThrow()
    expect(() => wecomKind.schema.parse({ chats: [{ chatId: 'wr_team' }, { chatId: 'wr_team' }] })).toThrow(/Duplicate chat IDs/)
    expect(() => wecomKind.policy!.schema.parse({ allowed: [{ id: 'boss' }, { id: 'boss' }] })).toThrow(/Duplicate userids/)
    const config = wecomKind.schema.parse({ botId: 'bot-1', chats: [{ chatId: 'wr_team', name: '老板群' }], otherChats: 'mentions', directMessages: false })
    expect(wecomKind.scope!({ meta: { chatId: 'wr_team', direct: false } }, config)).toEqual({ listened: true, observed: false, row: 'wr_team' })
    expect(wecomKind.scope!({ meta: { chatId: 'wr_other', direct: false } }, config)).toEqual({ listened: true, observed: false, row: 'other' })
    expect(wecomKind.scope!({ meta: { chatId: 'boss', direct: true } }, config)).toEqual({ listened: false, reason: 'direct_messages_not_allowed' })
    const allowed = wecomKind.channel!.allowed!
    expect(allowed({ chatId: 'wr_team', chatType: 'group' }, config)).toBe(true)
    expect(allowed({ chatId: 'boss', chatType: 'single' }, config)).toBe(false)
    expect(wecomKind.policy!.rows!(config).map(row => row.id)).toEqual(['wr_team', 'other', 'direct'])
    process.env.WECOM_BOT_SECRET = 'super-secret'
    expect(wecomCredentials(wecomKind.schema.parse({ botId: 'bot-1' }))).toEqual({ botId: 'bot-1', secret: 'super-secret' })
    expect(wecomCredentials(wecomKind.schema.parse({ secretEnv: 'WECOM_SECRET_FILE' }))).toBeUndefined()
    process.env.WECOM_BOT_ID = 'bot-from-env'
    process.env.WECOM_SECRET_FILE = 'other-secret'
    expect(wecomCredentials(wecomKind.schema.parse({ secretEnv: 'WECOM_SECRET_FILE' }))).toEqual({ botId: 'bot-from-env', secret: 'other-secret' })
    expect(WECOM_CREDENTIALS).not.toContain('super-secret')
    expect(wecomKind.environment!.values({ deployment: testDeployment(), config, trigger: wecomTrigger(textFrame(), NOW) })).toMatchObject({
      DSH_SUPERAGENT_WECOM_BOT: 'bot-1', DSH_SUPERAGENT_WECOM_CHAT: 'wr_team',
    })
    expect(wecomKind.environment!.values({ deployment: testDeployment(), config }).DSH_SUPERAGENT_WECOM_CHAT).toBe('')
    expect(JSON.stringify(wecomKind.environment!.values({ deployment: testDeployment(), config }))).not.toContain('super-secret')
  })
})

describe('wecom send framing', () => {
  it('sends markdown, and a button card when the gate report fits', () => {
    const prose = wecomOutbound('到账确认，可以记上。', 'group', 'msg-9')
    expect(prose).toEqual({ chat_type: 2, msgtype: 'markdown', markdown: { content: '到账确认，可以记上。' } })
    const card = wecomOutbound('待你确认\n① 合并\n② 再看', 'single', 'msg/9')
    expect(card).toMatchObject({
      chat_type: 1, msgtype: 'template_card',
      template_card: {
        card_type: 'button_interaction', task_id: wecomTaskId('msg/9'),
        main_title: { title: '待你确认' },
        button_list: [{ text: '① 合并', key: '① 合并', style: 1 }, { text: '② 再看', key: '② 再看', style: 1 }],
      },
    })
    expect(wecomOutbound('① 合并\n② 再看', 'group', 'bare')).toMatchObject({
      msgtype: 'template_card', template_card: { main_title: { title: '待确认' } },
    })
    expect(wecomTaskId('msg/9')).toBe('msg9')
    const long = `说明\n${'字'.repeat(113)}\n① 合并\n② 再看`
    expect(wecomOutbound(long, 'group', 'm').msgtype).toBe('markdown')
    expect(wecomOutbound('只有一句\n① 合并', 'group', 'm').msgtype).toBe('markdown')
  })

  it('pushes on the open connection and treats a missing chat as gone', async () => {
    const message = { id: 'out-1', channel: { source: 'wecom', thread: 'wecom:wr_team', address: { chatId: 'wr_team', chatType: 'group', messageId: 'msg-1' } },
      text: '到账了，可以记上。', kind: 'notice' as const }
    await expect(sendWecom({ commands: {} as never }, message)).rejects.toThrow(/not ready/)
    const socket = new FakeSocket()
    const release = bindWecomSend((chatId, body) => socket.sendMessage(chatId, body))
    expect(await sendWecom({ commands: {} as never }, message)).toBe('sent')
    expect(socket.sent).toEqual([{ chatId: 'wr_team', body: wecomOutbound('到账了，可以记上。', 'group', 'out-1') }])
    socket.fail = { errcode: 93000, errmsg: 'chatid invalid' }
    expect(await sendWecom({ commands: {} as never }, message)).toBe('gone')
    socket.fail = new Error('socket closed')
    await expect(sendWecom({ commands: {} as never }, message)).rejects.toThrow(/socket closed/)
    expect(wecomGone(new Error('timeout'))).toBe(false)
    release()
    expect(wecomLink({ chatId: 'wr_team', messageId: 'msg-1' })).toEqual({ url: '', label: { zh: '企业微信消息', en: 'WeCom message' }, triggerId: key('wecom', 'msg-1') })
  })
})

describe('wecom thread context', () => {
  it('returns only the triggering message', async () => {
    const trigger = wecomTrigger(textFrame(), NOW)!
    expect(wecomThreadContext.messageId(trigger)).toBe('msg-1')
    const thread = await wecomThreadContext.read({} as never, trigger, 'thread', undefined, {})
    expect(thread.messages).toEqual([{ id: 'msg-1', from: 'boss', at: NOW, text: '可以合并' }])
    expect(thread.status).toMatch(/no history/)
    const parent = await wecomThreadContext.read({} as never, trigger, 'parent', undefined, {})
    expect(parent.messages).toEqual([])
    const root = await wecomThreadContext.read({} as never, trigger, 'root', undefined, {})
    expect(root.messages).toEqual(thread.messages)
  })
})

describe('wecom companion', () => {
  it('uses one greeting line or one received line, and does not queue a second notice', () => {
    expect(`${WECOM_GREETING}\n${WECOM_RECEIVED}`).not.toMatch(/闸门|呈报/)
    expect(checkedImText(WECOM_GREETING)).toBe(WECOM_GREETING)
    expect(checkedImText(WECOM_RECEIVED)).toBe(WECOM_RECEIVED)
    expect(wecomCompanionText('你好')).toBe(WECOM_GREETING)
    expect(wecomCompanionText('  Hello! ')).toBe(WECOM_GREETING)
    expect(wecomCompanionText('有业务')).toBe(WECOM_RECEIVED)
    expect(wecomCompanionText('找老板')).toBe(WECOM_RECEIVED)
    expect(wecomCompanionText('你好，把按钮改成保存')).toBe(WECOM_RECEIVED)
    const hello = wecomTrigger(textFrame({ msgid: 'hi-1', chatid: undefined, chattype: 'single', text: { content: '你好' } }), NOW)!
    const notice = wecomCompanionNotice(hello)
    expect(notice).toMatchObject({ id: key('wecom-notice', hello.id), kind: 'notice', text: WECOM_GREETING, channel: hello.channel })
    const h = host()
    queueWecomCompanion(h.ctx, hello, 'filtered')
    expect(h.store.receipts.get(notice!.id)).toBeUndefined()
    queueWecomCompanion(h.ctx, hello, 'stored')
    queueWecomCompanion(h.ctx, hello, 'duplicate')
    expect(h.store.receipts.waiting().filter(item => item.id === notice!.id)).toEqual([expect.objectContaining({ text: WECOM_GREETING, kind: 'notice' })])
    const vague = wecomTrigger(textFrame({ msgid: 'biz-1', chatid: undefined, chattype: 'single', text: { content: '有业务' } }), NOW)!
    h.store.receipts.add({ id: key('ack', vague.id), channel: vague.channel!, text: '已经回过', kind: 'acknowledgement' })
    queueWecomCompanion(h.ctx, vague, 'stored')
    expect(h.store.receipts.get(key('wecom-notice', vague.id))).toBeUndefined()
    h.close()
  })
})

describe('wecom connection', () => {
  it('authenticates one socket, takes a boss message, and refuses a second socket for the same bot', async () => {
    const h = host()
    const socket = new FakeSocket()
    setWecomSocketFactory(() => socket)
    process.env.WECOM_BOT_SECRET = 'super-secret'
    const stop = new AbortController()
    const session = track(runWecomSession(h.ctx, { botId: 'bot-1', secret: 'super-secret' }, stop.signal), stop)
    await vi.waitFor(() => expect(socket.connected).toBe(true))
    await expect(runWecomSession(h.ctx, { botId: 'bot-1', secret: 'super-secret' }, new AbortController().signal)).rejects.toThrow(/already open/)
    socket.emit('authenticated')
    await vi.waitFor(() => expect(h.health.wecom).toMatchObject({ state: 'ready', detail: 'Long connection ready for bot-1' }))
    expect(h.health.wecom?.detail).not.toContain('super-secret')
    socket.emit('message.text', textFrame())
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalled())
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(h.engine.candidate(key('wecom', 'msg-1'))?.strength).toBe('explicit')
    expect(h.store.threads.get('wecom:wr_team')?.meta.label).toBe('老板群')
    socket.emit('message.text', textFrame({ msgid: 'msg-2', chatid: 'wr_other', text: { content: '别处' } }))
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(2))
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    socket.emit('message.text', textFrame({ msgid: 'msg-3', msgtype: 'image', text: undefined }))
    socket.emit('reconnecting', 2)
    await vi.waitFor(() => expect(h.health.wecom).toMatchObject({ state: 'error', detail: 'Reconnecting to WeCom (attempt 2)' }))
    await expect(sendWecom({ commands: h.deps.commands }, { id: 'out-2', kind: 'notice', text: '晚了',
      channel: { source: 'wecom', thread: 'wecom:wr_team', address: { chatId: 'wr_team', chatType: 'group', messageId: 'msg-1' } } })).rejects.toThrow(/not ready/)
    socket.emit('event.disconnected_event', {})
    await expect(session).rejects.toThrow(/another connection subscribed bot-1/)
    expect(socket.closed).toBe(true)
    expect(() => acquireWecomBot('bot-1')()).not.toThrow()
    h.close()
  })

  it('reports a missing secret and an authentication failure without connecting twice', async () => {
    const off = host(false)
    const stopOff = new AbortController()
    const paused = track(watchWecom(off.ctx, stopOff.signal), stopOff)
    await vi.waitFor(() => expect(off.health.wecom).toMatchObject({ state: 'paused', code: 'sourceOff' }))
    stopOff.abort()
    await paused
    off.close()

    const h = host()
    const sockets: FakeSocket[] = []
    setWecomSocketFactory(() => { const socket = new FakeSocket(); sockets.push(socket); return socket })
    const stop = new AbortController()
    const loop = track(watchWecom(h.ctx, stop.signal), stop)
    await vi.waitFor(() => expect(h.health.wecom?.detail).toBe(WECOM_CREDENTIALS))
    expect(sockets).toEqual([])
    process.env.WECOM_BOT_ID = 'bot-1'
    process.env.WECOM_BOT_SECRET = 'super-secret'
    // The loop is sleeping on the missing-secret delay; abort and the next test covers auth on a fresh loop.
    stop.abort()
    await loop
    const again = new AbortController()
    const second = track(watchWecom(h.ctx, again.signal), again)
    await vi.waitFor(() => expect(sockets[0]?.connected).toBe(true))
    sockets[0]!.emit('error', new WSAuthFailureError(3))
    await vi.waitFor(() => expect(h.health.wecom).toMatchObject({ state: 'error', detail: expect.stringContaining('Max auth failure') }))
    expect(String(h.health.wecom?.detail)).not.toContain('super-secret')
    again.abort()
    await second
    expect(wecomRetry(undefined, 10)).toBe(1000)
    expect(wecomRetry(1000, 10)).toBe(2000)
    expect(wecomRetry(1000, 60_000)).toBe(1000)
    h.close()
  })

  it('posts one companion notice for a direct greeting and for a card click', async () => {
    const h = host()
    const socket = new FakeSocket()
    setWecomSocketFactory(() => socket)
    process.env.WECOM_BOT_SECRET = 'super-secret'
    const stop = new AbortController()
    const session = track(runWecomSession(h.ctx, { botId: 'bot-1', secret: 'super-secret' }, stop.signal), stop)
    await vi.waitFor(() => expect(socket.connected).toBe(true))
    socket.emit('authenticated')
    await vi.waitFor(() => expect(h.health.wecom?.state).toBe('ready'))
    const hello = textFrame({ msgid: 'hi-1', chatid: undefined, chattype: 'single', text: { content: '你好' } })
    socket.emit('message.text', hello)
    const helloId = key('wecom-notice', wecomTrigger(hello, NOW)!.id)
    await vi.waitFor(() => expect(h.store.receipts.get(helloId)).toMatchObject({
      kind: 'notice', text: WECOM_GREETING, channel: { address: { chatId: 'boss', chatType: 'single' } },
    }))
    socket.emit('message.text', hello)
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(2))
    expect(await h.receive.mock.results[1]!.value).toBe('duplicate')
    expect(h.store.receipts.waiting().filter(item => item.id === helloId)).toHaveLength(1)
    const click = { body: { msgid: 'evt-9', chattype: 'single', from: { userid: 'boss' }, msgtype: 'event',
      event: { eventtype: 'template_card_event', event_key: '① 合并', task_id: 'task-9' } } }
    socket.emit('event.template_card_event', click)
    const clickId = key('wecom-notice', wecomTrigger(click, NOW)!.id)
    await vi.waitFor(() => expect(h.store.receipts.get(clickId)?.text).toBe(WECOM_RECEIVED))
    expect(await h.receive.mock.results[2]!.value).toBe('stored')
    expect(h.store.triggers.get(wecomTrigger(click, NOW)!.id)?.text).toBe('① 合并')
    stop.abort()
    await session
    h.close()
  })

  it('registers the kind and pauses until setup', async () => {
    const h = host()
    h.deps.configured = () => false
    const sources = new SourceRegistry(() => h.store.settings(), new HealthBoard())
    const disposers: (() => unknown)[] = []
    const value = { ...h.deps, sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ ...h.deps, sources }, kind) }
    applyWecom({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(sources.kind('wecom')).toBe(wecomKind)
    await vi.waitFor(() => expect(sources.healthEntries(['wecom']).get('wecom')?.get()).toMatchObject({ state: 'paused', code: 'setupPending' }))
    for (const dispose of disposers) await dispose()
    expect(sources.kind('wecom')).toBeUndefined()
    h.close()
  })
})
