/** WeCom Source: frame translation, gate-card framing, configuration, and the long-connection loop without live credentials. */
import { mkdtempSync, rmSync } from 'node:fs'
import { realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { WSAuthFailureError } from '@wecom/aibot-node-sdk'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { checkedImText } from '../src/infra/text.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { MasterAssessor } from '../src/app/assessment.ts'
import { TextCache } from '../src/app/cache.ts'
import { candidateCard } from '../src/app/links.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { WECOM_GREETING, WECOM_RECEIVED, sendWecom, wecomCompanionNotice, wecomCompanionText, wecomGone, wecomLink, wecomOutbound, wecomTaskId, type WecomOutbound } from '../src/sources/wecom-channel.ts'
import { imageMediaType, materializeWecomImages } from '../src/sources/wecom-image.ts'
import { wecomThreadContext } from '../src/sources/wecom-read.ts'
import { acquireWecomBot, bindWecomSend, resetWecomRuntime, setWecomSocketFactory, type WecomSocket } from '../src/sources/wecom-socket.ts'
import { apply as applyWecom, queueWecomCompanion, runWecomSession, watchWecom, WECOM_CREDENTIALS, wecomCredentials, wecomKind, wecomRetry } from '../src/sources/wecom.ts'
import { WECOM_FILE_NOTE, WECOM_IMAGE_EXTRA, WECOM_IMAGE_MISSED, wecomTime, wecomTrigger } from '../src/sources/wecom-trigger.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const NOW = '2026-11-04T03:00:00.000Z'
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
const saved = { ...process.env }
const stops: AbortController[] = []
const running: Promise<unknown>[] = []

class FakeSocket implements WecomSocket {
  readonly handlers = new Map<string, ((payload: unknown) => void)[]>()
  readonly sent: { chatId: string; body: WecomOutbound }[] = []
  readonly downloads: { url: string; aesKey?: string }[] = []
  readonly files = new Map<string, Uint8Array>()
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
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Uint8Array; filename?: string }> {
    this.downloads.push({ url, ...(aesKey ? { aesKey } : {}) })
    const buffer = this.files.get(url)
    if (!buffer) return Promise.reject(new Error('missing file'))
    return Promise.resolve({ buffer, filename: '../../outside.png' })
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
  const deployment = testDeployment({ stateDir: directory })
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
    const mixed = wecomTrigger(textFrame({ msgtype: 'mixed', text: undefined, mixed: { msg_item: [
      { msgtype: 'text', text: { content: '看一下' } }, { msgtype: 'image', image: { url: 'https://example.invalid/a', aeskey: 'aes-secret' } },
      { msgtype: 'text', text: { content: '再决定' } },
    ] } }), NOW)
    expect(mixed?.text).toBe('看一下\n[图片 wximg_1]\n再决定')
    expect(mixed?.text).not.toContain('example.invalid')
    expect(mixed?.text).not.toContain('aes-secret')
    const quoted = wecomTrigger(textFrame({
      text: { content: '按这个做' },
      quote: { msgtype: 'text', text: { content: '昨天的 SOP' } },
    }), NOW)
    expect(quoted?.text).toBe('引用：昨天的 SOP\n按这个做')
    const quotedPicture = wecomTrigger(textFrame({
      text: { content: '按这个做' },
      quote: { msgtype: 'image', image: { url: 'https://example.invalid/sop', aeskey: 'aes-secret' } },
    }), NOW)
    expect(quotedPicture?.text).toBe('引用：\n[图片 wximg_1]\n按这个做')
    expect(JSON.stringify(quotedPicture?.text)).not.toContain('aes-secret')
    const click = wecomTrigger({ body: { msgid: 'evt-1', create_time: 1_700_000_000, chatid: 'wr_team', chattype: 'group',
      from: { userid: 'boss' }, msgtype: 'event', event: { eventtype: 'template_card_event', event_key: '① 合并', task_id: 'task-1' } } }, NOW)
    expect(click).toMatchObject({ text: '① 合并', addressed: 'mention', meta: { eventKey: '① 合并', taskId: 'task-1' } })
  })

  it('drops a picture with no url, session entry, the bot itself, assistant callbacks and a group event with no chat', () => {
    expect(wecomTrigger(textFrame({ msgtype: 'image', text: undefined }), NOW)).toBeUndefined()
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

describe('wecom pictures', () => {
  it('downloads and decrypts a picture, and never stores the url or aes key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wecom-image-'))
    const aes = 'aes-secret-value'
    const url = 'https://example.invalid/sop.png'
    const parsed = wecomTrigger(textFrame({
      msgid: 'sop-1', chatid: undefined, chattype: 'single', msgtype: 'mixed', text: undefined,
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '新建业务线' } },
        { msgtype: 'image', image: { url, aeskey: aes } },
        { msgtype: 'text', text: { content: '外贸跟单 SOP' } },
      ] },
    }), NOW)!
    const seen: { url: string; aesKey?: string }[] = []
    const trigger = await materializeWecomImages(parsed, async (got, aesKey) => {
      seen.push({ url: got, ...(aesKey ? { aesKey } : {}) })
      return { buffer: PNG, filename: '../../etc/passwd.png' }
    }, directory)
    expect(seen).toEqual([{ url, aesKey: aes }])
    expect(trigger.text).toBe('新建业务线\n[图片 wximg_1]\n外贸跟单 SOP')
    expect(JSON.stringify(trigger)).not.toContain(aes)
    expect(JSON.stringify(trigger)).not.toContain(url)
    expect(trigger.meta.pendingMedia).toBeUndefined()
    const saved = trigger.meta.images as { key: string; file: string; mediaType: string }[]
    expect(saved).toEqual([{ key: 'wximg_1', file: expect.stringMatching(/^wecom-images\/[a-f0-9]{32}-wximg_1\.png$/), mediaType: 'image/png' }])
    const path = join(directory, ...saved[0]!.file.split('/'))
    expect(await realpath(path)).toBe(join(await realpath(directory), saved[0]!.file))
    rmSync(directory, { recursive: true, force: true })
  })

  it('keeps a caption when the picture cannot be fetched, and does not follow a non-https url', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wecom-image-'))
    const http = wecomTrigger(textFrame({ msgid: 'http-1', chatid: undefined, chattype: 'single', msgtype: 'image', text: undefined,
      image: { url: 'http://example.invalid/a', aeskey: 'aes-secret-value' } }), NOW)!
    const calls: string[] = []
    const blocked = await materializeWecomImages(http, async () => { calls.push('called'); return { buffer: PNG } }, directory)
    expect(calls).toEqual([])
    expect(blocked.text).toBe(WECOM_IMAGE_MISSED)
    expect(JSON.stringify(blocked)).not.toContain('example.invalid')
    expect(JSON.stringify(blocked)).not.toContain('aes-secret-value')
    const failed = wecomTrigger(textFrame({ msgid: 'fail-1', chatid: undefined, chattype: 'single', text: { content: '看这张' },
      quote: { msgtype: 'image', image: { url: 'https://example.invalid/a', aeskey: 'aes-secret-value' } } }), NOW)!
    const missed = await materializeWecomImages(failed, async () => { throw new Error('download failed') }, directory)
    expect(missed.text).toBe('引用：\n（这张图片没有取到）\n看这张')
    expect(JSON.stringify(missed)).not.toContain('aes-secret-value')
    const huge = wecomTrigger(textFrame({ msgid: 'huge-1', chatid: undefined, chattype: 'single', msgtype: 'image', text: undefined,
      image: { url: 'https://example.invalid/a', aeskey: 'k' } }), NOW)!
    const over = await materializeWecomImages(huge, async () => ({ buffer: PNG }), directory, 8)
    expect(over.text).toBe(WECOM_IMAGE_MISSED)
    expect(over.meta.images).toBeUndefined()
    rmSync(directory, { recursive: true, force: true })
  })

  it('treats a file as a picture only when the bytes are one', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wecom-image-'))
    const pngFile = wecomTrigger(textFrame({ msgid: 'file-png', chatid: undefined, chattype: 'single', msgtype: 'file', text: undefined,
      file: { url: 'https://example.invalid/sheet', aeskey: 'k' } }), NOW)!
    const picture = await materializeWecomImages(pngFile, async () => ({ buffer: PNG }), directory)
    expect(picture.text).toBe('[图片 wximg_1]')
    expect(picture.meta.images).toMatchObject([{ mediaType: 'image/png' }])
    const pdf = wecomTrigger(textFrame({ msgid: 'file-pdf', chatid: undefined, chattype: 'single', msgtype: 'file', text: undefined,
      file: { url: 'https://example.invalid/sheet.pdf', aeskey: 'k' } }), NOW)!
    const note = await materializeWecomImages(pdf, async () => ({ buffer: Buffer.from('%PDF-1.4') }), directory)
    expect(note.text).toBe(WECOM_FILE_NOTE)
    expect(note.meta.images).toBeUndefined()
    expect(JSON.stringify(note)).not.toContain('sheet.pdf')
    const extra = wecomTrigger(textFrame({ msgid: 'many', chatid: undefined, chattype: 'single', msgtype: 'mixed', text: undefined, mixed: { msg_item: [
      { msgtype: 'image', image: { url: 'https://example.invalid/1', aeskey: 'k' } },
      { msgtype: 'image', image: { url: 'https://example.invalid/2', aeskey: 'k' } },
      { msgtype: 'image', image: { url: 'https://example.invalid/3', aeskey: 'k' } },
      { msgtype: 'image', image: { url: 'https://example.invalid/4', aeskey: 'k' } },
      { msgtype: 'image', image: { url: 'https://example.invalid/5', aeskey: 'k' } },
    ] } }), NOW)!
    expect(extra.text).toContain(WECOM_IMAGE_EXTRA)
    expect(extra.meta.pendingMedia).toHaveLength(4)
    expect(JSON.stringify(extra)).not.toContain('example.invalid/5')
    expect(imageMediaType(Uint8Array.from([0xff, 0xd8, 0xff, 0xe0]))).toBe('image/jpeg')
    expect(imageMediaType(Buffer.from('GIF89a'))).toBe('image/gif')
    expect(imageMediaType(Uint8Array.from([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]))).toBe('image/webp')
    expect(imageMediaType(Buffer.from('hello'))).toBeUndefined()
    rmSync(directory, { recursive: true, force: true })
  })

  it('puts the picture on the BotFather turn the session actually sees', async () => {
    const h = host()
    const dir = join(h.deps.deployment.stateDir, 'botfactory', 'identities')
    h.store.saveSettings(SettingsSchema.parse({
      eval: { mode: 'auto' },
      sources: { wecom: { enabled: true, config: { chats: [{ chatId: 'wr_team', name: '老板群' }], directMessages: true, otherChats: 'none', identitiesDir: dir } } },
      policy: { sources: { wecom: { allowed: [{ id: 'boss', name: '老板' }] } } },
    }))
    const aes = 'aes-secret-value'
    const url = 'https://example.invalid/sop.png'
    const parsed = wecomTrigger(textFrame({
      msgid: 'sop-2', chatid: undefined, chattype: 'single', msgtype: 'mixed', text: undefined,
      mixed: { msg_item: [
        { msgtype: 'text', text: { content: '新建业务线' } },
        { msgtype: 'image', image: { url, aeskey: aes } },
        { msgtype: 'text', text: { content: '外贸跟单 SOP' } },
      ] },
    }), NOW)!
    const trigger = await materializeWecomImages(parsed, async () => ({ buffer: PNG }), h.deps.deployment.stateDir)
    const delivered: { text: string; images: { data: Uint8Array; mediaType: string; name: string }[] }[] = []
    let run: ((payload: { triggerId: string }, evalId: string) => Promise<void>) | undefined
    new MasterAssessor({
      get engine() { return h.engine }, commands: h.deps.commands, deployment: h.deps.deployment, settings: () => h.store.settings(),
      paused: () => false, threadContext: () => undefined,
      effects: { enqueue() {}, handle(_kind, fn) { run = fn as typeof run } },
      deliver: async (_id, text, images) => { delivered.push({ text, images: [...images ?? []] }) },
      candidateCard: candidate => candidateCard({
        store: h.store, links: new TextCache(1000), commands: h.deps.commands, sources: h.sources, lifetime: new AbortController().signal,
      }, candidate),
    })
    expect(h.engine.receive(trigger)).toBe('stored')
    h.engine.evaluateDue()
    queueWecomCompanion(h.ctx, trigger, 'stored', dir)
    expect(h.store.receipts.waiting()).toEqual([])
    const candidate = h.engine.candidate(trigger.id)
    expect(candidate?.strength).toBe('explicit')
    await run!({ triggerId: trigger.id }, candidate!.evalId)
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.text).toContain('[图片 wximg_1]')
    expect(delivered[0]!.text).toContain('外贸跟单 SOP')
    expect(delivered[0]!.text).toContain('BotFather')
    expect(delivered[0]!.text).not.toContain(aes)
    expect(delivered[0]!.images.map(image => ({ mediaType: image.mediaType, name: image.name }))).toEqual([{ mediaType: 'image/png', name: 'wximg_1.png' }])
    expect(Buffer.from(delivered[0]!.images[0]!.data).equals(PNG)).toBe(true)
    h.close()
  })

  it('downloads an image frame on the socket before the trigger is stored', async () => {
    const h = host()
    const socket = new FakeSocket()
    const url = 'https://example.invalid/shot'
    socket.files.set(url, PNG)
    setWecomSocketFactory(() => socket)
    process.env.WECOM_BOT_SECRET = 'super-secret'
    const stop = new AbortController()
    const session = track(runWecomSession(h.ctx, { botId: 'bot-1', secret: 'super-secret' }, stop.signal), stop)
    await vi.waitFor(() => expect(socket.connected).toBe(true))
    socket.emit('authenticated')
    socket.emit('message.image', textFrame({ msgid: 'img-9', chatid: undefined, chattype: 'single', msgtype: 'image', text: undefined,
      image: { url, aeskey: 'aes-secret-value' } }))
    await vi.waitFor(() => expect(h.store.triggers.get(key('wecom', 'img-9'))?.text).toBe('[图片 wximg_1]'))
    const stored = h.store.triggers.get(key('wecom', 'img-9'))
    expect(JSON.stringify(stored)).not.toContain('aes-secret-value')
    expect(JSON.stringify(stored)).not.toContain(url)
    expect(socket.downloads).toEqual([{ url, aesKey: 'aes-secret-value' }])
    expect(stored?.meta.images).toMatchObject([{ mediaType: 'image/png' }])
    stop.abort()
    await session
    h.close()
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
    expect(wecomThreadContext.images?.('可以合并')).toEqual([])
  })

  it('reads a stored picture by the key written into the message', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'wecom-image-'))
    const parsed = wecomTrigger(textFrame({ msgid: 'img-read', chatid: undefined, chattype: 'single', msgtype: 'image', text: undefined,
      image: { url: 'https://example.invalid/a', aeskey: 'k' } }), NOW)!
    const trigger = await materializeWecomImages(parsed, async () => ({ buffer: PNG }), directory)
    expect(wecomThreadContext.images?.(trigger.text)).toEqual(['wximg_1'])
    const saveImage = vi.fn().mockResolvedValue({ attachmentId: 'img' })
    const ctx = new Context()
    ctx.reflect.provide('attachments', { saveImage, imageLimits: { maxImageBytes: 1000, maxMessageImageBytes: 1000 } })
    ctx.reflect.provide('llm', { resolveModelInfo: vi.fn().mockResolvedValue({ inputModalities: ['text', 'image'] }) })
    const agent = { ctx, session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) }, options: {} } as unknown as Agent
    const message = { id: String(trigger.meta.messageId), text: trigger.text }
    const read = await wecomThreadContext.image!(agent, {} as never, trigger, message, 'wximg_1', directory, new AbortController().signal)
    expect(read).toMatchObject({ source_message_id: 'img-read', image_key: 'wximg_1', image: { attachmentId: 'img' } })
    expect(saveImage).toHaveBeenCalledWith({ data: expect.any(Uint8Array), mediaType: 'image/png', name: 'wximg_1.png' })
    await expect(wecomThreadContext.image!(agent, {} as never, trigger, message, 'wximg_9', directory, new AbortController().signal)).rejects.toThrow(/source message/)
    rmSync(directory, { recursive: true, force: true })
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
    expect(socket.handlers.has('message.image')).toBe(true)
    expect(socket.handlers.has('message.file')).toBe(true)
    socket.emit('message.text', textFrame({ msgid: 'msg-3', msgtype: 'image', text: undefined }))
    socket.emit('message.text', textFrame({ msgid: 'msg-4', text: { content: '下一句' } }))
    await vi.waitFor(() => expect(h.receive).toHaveBeenCalledTimes(3))
    expect(h.receive.mock.calls[2]![0].text).toBe('下一句')
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
