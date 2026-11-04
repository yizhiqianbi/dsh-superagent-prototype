/** Idempotent message delivery to DSH agents across Session restarts. */
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { freezeMessage, MessageId, type ContentBlock, type ContextFormed, type UserMessage } from '@deepseek-ai/dsh-llm'
import type { Session } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-superagent': { kind: 'dsh-superagent' } & ContextFormed
  }
}

type Seen = { ids: Set<string>; loaded?: Promise<void> }
/** One picture to place beside a steered user message. Bytes are already decrypted. */
export interface DeliveryImage { data: Uint8Array; mediaType: ImageMediaType; name: string }
/** The id of the message delivered under `requestId`, the same on every retry. */
export const messageId = (requestId: string) => MessageId(`dsh-superagent:${requestId}`)
/** Extracts the idempotency key from current or legacy plugin message sources. */
function deliveryId(message: UserMessage): string | undefined {
  // Persisted sources may predate the current producer-specific source map.
  const source: { kind: string; plugin?: unknown; rpcId?: unknown } = message.source
  if (source.kind === 'dsh-superagent' || (source.kind === 'plugin' && source.plugin === 'dsh-superagent')) return message.id
  // Requests admitted by the former user RPC retain their original attribution.
  if (source.kind === 'user' && 'rpcId' in source && typeof source.rpcId === 'string') return messageId(source.rpcId)
}

/**
 * Delivers messages to DSH agents at most once per request ID across active and restored Sessions.
 * Tracks delivered message IDs from live Session events, persisted history, and pending inboxes so retries from `Sessions` do not duplicate messages,
 * and marks delivered messages with `dsh-superagent`'s own source (`dsh-superagent`) rather than user RPCs so they are never mistaken for messages written by a person.
 */
export class AgentDelivery {
  private readonly seen = new WeakMap<Session, Seen>()
  constructor(private readonly ctx: Context) {
    ctx.on('session/event', (session, event) => {
      if (event.type !== 'user/message') return
      const id = deliveryId(event.data)
      if (id) this.seen.get(session)?.ids.add(id)
    })
  }
  private async history(agent: Agent): Promise<Seen> {
    let seen = this.seen.get(agent.session)
    if (!seen) { seen = { ids: new Set() }; this.seen.set(agent.session, seen) }
    const state = seen
    state.loaded ??= (async () => {
      await this.ctx.sessionPersistence.flush()
      await using handle = await this.ctx.sessionPersistence.open(agent.id, 'read')
      for (let offset = 0; ; ) {
        const { events } = await handle.read(offset, 512)
        if (!events.length) break
        for (const event of events) {
          if (event.type !== 'user/message') continue
          const id = deliveryId(event.data)
          if (id) state.ids.add(id)
        }
        offset += events.length
      }
    })().catch(error => { state.loaded = undefined; throw error })
    await state.loaded
    return state
  }
  async holds(agent: Agent, requestId: string): Promise<boolean> {
    const id = messageId(requestId)
    return (await this.history(agent)).ids.has(id) || [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
  }
  /** Delivers once to the selected inbox, or injects into history without waking the agent, and flushes Session persistence before acknowledging the producer. */
  async send(agent: Agent, requestId: string, text: string, mode: 'queue' | 'steer' | { inject: string }, signal: AbortSignal, authorize?: () => void,
    accepted?: () => void, images: readonly DeliveryImage[] = []): Promise<void> {
    signal.throwIfAborted()
    const seen = await this.history(agent)
    signal.throwIfAborted()
    if (this.ctx.agents.get(agent.id) !== agent) throw new Error('Delivery target was disposed')
    authorize?.()
    const id = messageId(requestId)
    const pending = [...agent.inbox.nextTurn, ...agent.inbox.nextStep].some(message => deliveryId(message) === id)
    if (!seen.ids.has(id) && !pending) {
      const source = typeof mode === 'object' ? { kind: 'dsh-superagent' as const, form: 'notice' as const, summary: mode.inject }
        : { kind: 'dsh-superagent' as const, form: 'relay' as const }
      const pictures = typeof mode === 'object' ? [] : await this.attachImages(agent, images, signal)
      const content: ContentBlock[] = [{ type: 'text', text }, ...pictures]
      const message = freezeMessage({ id, role: 'user' as const, content, source })
      if (typeof mode === 'object') { agent.inject(message); seen.ids.add(id) }
      else if (mode === 'steer') agent.steer(message)
      else agent.followup(message)
    }
    accepted?.()
    await this.ctx.sessionPersistence.flush()
  }
  /** Saves pictures onto the turn. A model that declares text-only input does not receive them, and one bad picture does not drop the text. */
  private async attachImages(agent: Agent, images: readonly DeliveryImage[], signal: AbortSignal): Promise<ContentBlock[]> {
    if (!images.length || !(await this.modelSeesImages(agent, signal))) return []
    const attachments = service<{ saveImage?: (input: { data: Uint8Array; mediaType: ImageMediaType; name: string }) => Promise<ImageAttachmentRef> }>(agent, 'attachments')
    if (!attachments?.saveImage) return []
    const blocks: ContentBlock[] = []
    for (const image of images) {
      signal.throwIfAborted()
      try {
        const attachment = await attachments.saveImage({ data: image.data, mediaType: image.mediaType, name: image.name })
        blocks.push({ type: 'image', attachment })
      } catch { /* The text of the turn still arrives. */ }
    }
    return blocks
  }
  private async modelSeesImages(agent: Agent, signal: AbortSignal): Promise<boolean> {
    const llm = service<{ resolveModelInfo?: (provider: string, model: string, signal: AbortSignal) => Promise<{ inputModalities?: readonly string[] }> }>(agent, 'llm')
    if (!llm?.resolveModelInfo) return true
    const session = agent.session as { requestHeader?: () => { config?: { provider?: string; model?: string } } | undefined }
    const header = session.requestHeader?.()?.config
    const provider = header?.provider ?? agent.options?.provider
    const model = header?.model ?? agent.options?.model
    if (!provider || !model) return true
    try {
      const modes = (await llm.resolveModelInfo(provider, model, signal))?.inputModalities
      if (Array.isArray(modes) && modes.length > 0 && !modes.includes('image')) return false
      return true
    } catch {
      return true
    }
  }
}

function service<T>(agent: Agent, name: string): T | undefined {
  try { return agent.ctx.get(name) as T | undefined } catch { return undefined }
}
