/** Thread window for a WeCom trigger. The long connection has no history API, so this does not invent earlier messages. */
import type { Commands } from '../infra/commands.ts'
import type { Trigger } from '../core/index.ts'
import { readWecomImage } from './wecom-image.ts'
import { wecomImageKeys } from './wecom-trigger.ts'
import type { ContextMessage, ContextPart, ContextPartName, ThreadContext } from './kind.ts'

const HONEST = 'WeCom long connection keeps no history; only the triggering message is known.'

function own(trigger: Trigger): ContextMessage {
  return { id: String(trigger.meta.messageId ?? trigger.id), from: trigger.actor.id, at: trigger.at, text: trigger.text }
}

/** The trigger message for `thread` and `root`. `parent` is empty: a quote, when present, does not include its msgid. */
export const wecomThreadContext: ThreadContext<Record<string, unknown>> = {
  messageId: trigger => String(trigger.meta.messageId ?? ''),
  read(_commands: Commands, trigger: Trigger, part: ContextPartName, _cursor: string | undefined, _config: Record<string, unknown>): Promise<ContextPart> {
    const message = own(trigger)
    if (part === 'thread' || part === 'root') return Promise.resolve({ messages: [message], body: { messages: [message] }, status: HONEST })
    if (part === 'parent') return Promise.resolve({ messages: [], body: { messages: [] }, status: HONEST })
    const unreachable: never = part
    throw new Error(`Unknown WeCom thread part ${String(unreachable)}`)
  },
  images: wecomImageKeys,
  image: (agent, _commands, trigger, message, imageKey, stateDir, signal) => readWecomImage(agent, trigger, message, imageKey, stateDir, signal),
}
