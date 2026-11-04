/** Chooses the companion line: BotFather on a WeCom or Feishu direct message, otherwise the WeCom greeting. */
import type { Trigger } from '../core/index.ts'
import { SOURCE as FEISHU } from '../sources/feishu-trigger.ts'
import { WECOM_GREETING, wecomCompanionText } from '../sources/wecom-channel.ts'
import { SOURCE as WECOM } from '../sources/wecom-trigger.ts'
import { BOTFATHER_INIT, botfatherTurn, factoryStart, smokeFor } from './grill.ts'
import type { FactoryLibrary } from './store.ts'

export interface CompanionPlan { text: string; wired?: boolean; commit?: () => void }

function draftKey(trigger: Trigger, userid: string): string {
  return trigger.source === FEISHU ? `feishu-${userid}` : userid
}

/**
 * The host's single reply. Factory turns commit their draft only after the caller decides to send.
 * Feishu stays quiet except for the factory and a wired line's greeting, so ordinary Feishu chat is not given the WeCom received line.
 */
export function planCompanion(trigger: Trigger, library: FactoryLibrary | undefined): CompanionPlan | undefined {
  if (trigger.source !== WECOM && trigger.source !== FEISHU) return undefined
  const direct = trigger.meta.direct === true
  const userid = String(trigger.meta.userid ?? trigger.actor?.id ?? '')
  const chatId = String(trigger.meta.chatId ?? '')
  const feishu = trigger.source === FEISHU
  if (!library) {
    if (direct && factoryStart(trigger.text)) return { text: BOTFATHER_INIT }
    return feishu ? undefined : { text: wecomCompanionText(trigger.text) }
  }
  const key = draftKey(trigger, userid)
  const turn = botfatherTurn({
    direct, userid, text: trigger.text, route: library.route(),
    draft: userid ? library.draft(key) : undefined, identities: library.identities(),
  })
  if (!turn.handled) {
    const smoke = smokeFor(library.identities(), direct, chatId)
    if (feishu) return smoke && wecomCompanionText(trigger.text) === WECOM_GREETING ? { text: smoke } : undefined
    return { text: wecomCompanionText(trigger.text, smoke) }
  }
  return {
    text: turn.text,
    wired: turn.wired !== undefined,
    commit: () => {
      if (!userid) return
      if (turn.wired) library.saveIdentity(turn.wired)
      library.saveDraft(key, turn.draft)
    },
  }
}
