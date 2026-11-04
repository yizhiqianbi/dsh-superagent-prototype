/** Leaves a factory direct message to the session. Other chat keeps the companion line. */
import type { Trigger } from '../core/index.ts'
import { SOURCE as FEISHU } from '../sources/feishu-trigger.ts'
import { wecomCompanionText } from '../sources/wecom-channel.ts'
import { SOURCE as WECOM } from '../sources/wecom-trigger.ts'
import { factoryKey, remember } from './harness.ts'
import { BOTFATHER_INIT, FACTORY_STOP, ROUTE_BROKEN, factoryStart, factoryStop } from './grill.ts'
import type { FactoryLibrary } from './store.ts'

export interface CompanionPlan { text?: string; harness?: boolean; commit?: () => void }

/**
 * The host's reply, when it has one. A factory direct message only records the line (`harness`) so the session can talk.
 * A saved role does not change this bot's greeting. Feishu stays quiet outside that conversation.
 */
export function planCompanion(trigger: Trigger, library: FactoryLibrary | undefined): CompanionPlan | undefined {
  if (trigger.source !== WECOM && trigger.source !== FEISHU) return undefined
  const direct = trigger.meta.direct === true
  const userid = String(trigger.meta.userid ?? trigger.actor?.id ?? '')
  const feishu = trigger.source === FEISHU
  if (!library) {
    if (direct && factoryStart(trigger.text)) return { text: BOTFATHER_INIT }
    return feishu ? undefined : { text: wecomCompanionText(trigger.text) }
  }
  const key = factoryKey(trigger)
  const route = library.route()
  const draft = userid ? library.draft(key) : undefined
  if (direct && !route.ok && (factoryStart(trigger.text) || draft?.open)) {
    return { text: ROUTE_BROKEN, commit: () => { if (userid) library.saveDraft(key, null) } }
  }
  const allowed = route.ok && (route.operators.length === 0 || route.operators.includes(userid))
  const talking = direct && allowed && userid !== '' && (factoryStart(trigger.text) !== undefined || draft?.open === true)
  if (talking && factoryStop(trigger.text)) return { text: FACTORY_STOP, commit: () => { library.saveDraft(key, null) } }
  if (talking) return { harness: true, commit: () => { library.saveDraft(key, remember(draft, trigger.text)) } }
  if (feishu) return undefined
  return { text: wecomCompanionText(trigger.text) }
}
