import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage, type UserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionSeq, type SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it, vi } from 'vitest'
import { AgentDelivery, type DeliveryImage } from '../src/app/delivery.ts'

function fixture(history: UserMessage[] = []) {
  const ctx = new Context()
  const inbox = { nextTurn: [] as UserMessage[], nextStep: [] as UserMessage[] }
  const steer = vi.fn((message: UserMessage) => { inbox.nextStep.push(message) })
  const followup = vi.fn((message: UserMessage) => { inbox.nextTurn.push(message) })
  const injected = vi.fn((_message: UserMessage) => {})
  // Only the delivery-facing Agent methods participate in this fixture.
  const agent = { id: SessionId('delivery-test'), session: {}, inbox, steer, followup, inject: injected } as unknown as Agent
  const event = (message: UserMessage): SessionEvent => ({ type: 'user/message', seq: SessionSeq(0), time: 0, surfaceOp: 'append', data: message })
  const read = vi.fn(async (offset: number, length: number) => ({ events: history.slice(offset, offset + length).map(event) }))
  const close = vi.fn(async () => {})
  const flush = vi.fn(async () => {})
  const open = vi.fn(async () => ({ read, [Symbol.asyncDispose]: close }))
  const agents = new Map([[agent.id, agent]])
  ctx.reflect.provide('agents', agents)
  ctx.reflect.provide('sessionPersistence', { open, flush })
  const delivery = new AgentDelivery(ctx)
  const signal = new AbortController()
  const send = (id = 'request', mode: 'queue' | 'steer' = 'steer', images: readonly DeliveryImage[] = []) =>
    delivery.send(agent, id, '{"event_id":"event"}', mode, signal.signal, undefined, undefined, images)
  const inject = (id: string, summary: string) => delivery.send(agent, id, '{"settings_saved":"policy"}', { inject: summary }, signal.signal)
  const holds = (id: string) => delivery.holds(agent, id)
  const consume = (message: UserMessage) => {
    inbox.nextStep.splice(0); inbox.nextTurn.splice(0)
    ctx.emit('session/event', agent.session, event(message))
  }
  return { agent, agents, inbox, steer, followup, injected, open, read, close, flush, send, inject, holds, consume, signal }
}

it.each(['queue', 'steer'] as const)('delivers %s as an orchestrator relay, deduplicating pending and consumed messages', async mode => {
  const f = fixture()
  await f.send('request', mode)
  const target = mode === 'queue' ? f.followup : f.steer
  expect(target).toHaveBeenCalledOnce()
  const message = target.mock.calls[0]![0]
  expect(message.role).toBe('user')
  expect(message.source).toEqual({ kind: 'dsh-superagent', form: 'relay' })
  expect(Object.isFrozen(message)).toBe(true)
  await f.send('request', mode)
  f.consume(message)
  await f.send('request', mode)
  expect(target).toHaveBeenCalledOnce()
  expect(f.open).toHaveBeenCalledOnce()
  expect(f.close).toHaveBeenCalledOnce()
  const restored = fixture([message])
  await restored.send('request', mode)
  expect(restored.steer).not.toHaveBeenCalled()
  expect(restored.followup).not.toHaveBeenCalled()
})

it.each(['pending', 'consumed', 'live'] as const)('recognizes legacy plugin identity in %s input without rewriting it', async location => {
  // Bypass TypeScript's current source union to construct the retired serialized shape.
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin: 'dsh-superagent', form: 'relay' } }))
  const before = JSON.stringify(old)
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  if (location === 'live') f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(JSON.stringify(old)).toBe(before)
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['another-plugin', undefined])('does not treat a legacy plugin source %s as this producer', async plugin => {
  const old: UserMessage = JSON.parse(JSON.stringify({ id: 'dsh-superagent:request', role: 'user', content: [], source: { kind: 'plugin', plugin, form: 'relay' } }))
  const f = fixture([old])
  await f.send()
  expect(f.steer).toHaveBeenCalledOnce()
})

it.each(['pending', 'consumed'] as const)('recognizes legacy user RPC identity in %s input', async location => {
  const old = createUserMessage({ content: [{ type: 'text', text: 'old relay' }], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture(location === 'consumed' ? [old] : [])
  if (location === 'pending') f.inbox.nextTurn.push(old)
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(old.source.kind).toBe('user')
  await f.send('different-request')
  expect(f.steer).toHaveBeenCalledOnce()
})

it('retries a failed durability barrier without another delivery and permits concurrent retries', async () => {
  const f = fixture()
  f.flush.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('disk busy'))
  await expect(f.send()).rejects.toThrow('disk busy')
  f.consume(f.steer.mock.calls[0]![0])
  await Promise.all([f.send(), f.send()])
  expect(f.steer).toHaveBeenCalledOnce()
  expect(f.flush).toHaveBeenCalledTimes(4)
})

it('retries history failures and reads past the first page', async () => {
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  const f = fixture([...Array.from({ length: 512 }, () => createUserMessage({ content: [], source: { kind: 'user' } })), old])
  f.read.mockRejectedValueOnce(new Error('read failed'))
  await expect(f.send()).rejects.toThrow('read failed')
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
  expect(f.close).toHaveBeenCalledTimes(2)
})

it('keeps consumption that happens during the initial history read', async () => {
  const f = fixture()
  const old = createUserMessage({ content: [], source: { kind: 'user', rpcId: 'request' } })
  f.read.mockImplementationOnce(async () => { f.consume(old); return { events: [] } })
  await f.send()
  expect(f.steer).not.toHaveBeenCalled()
})

it('does not dispatch when cancelled or disposed during history loading', async () => {
  const cancelled = fixture()
  cancelled.read.mockImplementationOnce(async () => { cancelled.signal.abort(); return { events: [] } })
  await expect(cancelled.send()).rejects.toThrow()
  expect(cancelled.steer).not.toHaveBeenCalled()
  const disposed = fixture()
  disposed.read.mockImplementationOnce(async () => { disposed.agents.clear(); return { events: [] } })
  await expect(disposed.send()).rejects.toThrow('disposed')
  expect(disposed.steer).not.toHaveBeenCalled()
})

it('injects a notice once, as dsh-superagent\'s notice with its summary, without waking the agent', async () => {
  const f = fixture()
  await f.inject('notice:settings', 'Settings saved')
  await f.inject('notice:settings', 'Settings saved')
  expect(f.injected).toHaveBeenCalledOnce()
  expect(f.injected.mock.calls[0]![0]).toMatchObject({ role: 'user', source: { kind: 'dsh-superagent', form: 'notice', summary: 'Settings saved' } })
  expect([f.steer, f.followup].map(spy => spy.mock.calls.length)).toEqual([0, 0])
})

it('steers an image beside the text, and skips it when the model declares text only', async () => {
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
  const ref = { attachmentId: 'img', mediaType: 'image/png' as const, bytes: png.byteLength, width: 1, height: 1 }
  const image: DeliveryImage = { data: png, mediaType: 'image/png', name: 'wximg_1.png' }
  const saveImage = vi.fn(async () => ref)
  const f = fixture()
  const ctx = new Context()
  ctx.reflect.provide('attachments', { saveImage })
  Object.assign(f.agent, { ctx, options: {} })
  await f.send('request', 'steer', [image])
  expect(saveImage).toHaveBeenCalledWith({ data: png, mediaType: 'image/png', name: 'wximg_1.png' })
  expect(f.steer.mock.calls[0]![0].content).toEqual([
    { type: 'text', text: '{"event_id":"event"}' },
    { type: 'image', attachment: ref },
  ])
  const textOnly = fixture()
  const skipped = vi.fn(async () => ref)
  const quiet = new Context()
  quiet.reflect.provide('attachments', { saveImage: skipped })
  quiet.reflect.provide('llm', { resolveModelInfo: async () => ({ inputModalities: ['text'] }) })
  Object.assign(textOnly.agent, {
    ctx: quiet, options: { provider: 'p', model: 'm' }, session: { requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) },
  })
  await textOnly.send('request', 'steer', [image])
  expect(skipped).not.toHaveBeenCalled()
  expect(textOnly.steer.mock.calls[0]![0].content).toEqual([{ type: 'text', text: '{"event_id":"event"}' }])
})

it('tells whether the Session holds a message: one waiting in its inbox, one it took, and one in its stored history', async () => {
  const f = fixture()
  expect(await f.holds('request')).toBe(false)
  await f.send('request')
  expect(await f.holds('request')).toBe(true)
  f.consume(f.steer.mock.calls[0]![0])
  expect([f.inbox.nextStep.length, await f.holds('request')]).toEqual([0, true])
  const restored = fixture([f.steer.mock.calls[0]![0]])
  expect([await restored.holds('request'), await restored.holds('other')]).toEqual([true, false])
})
