/** Chooses the one companion line for a WeCom trigger: BotFather in a factory DM, otherwise the line's greeting. */
import type { Trigger } from '../core/index.ts'
import { wecomCompanionText } from '../sources/wecom-channel.ts'
import { SOURCE } from '../sources/wecom-trigger.ts'
import { BOTFATHER_INIT, botfatherTurn, factoryStart, smokeFor } from './grill.ts'
import type { FactoryLibrary } from './store.ts'

export interface CompanionPlan { text: string; wired?: boolean; commit?: () => void }

/** The host's single reply. Factory turns commit their draft only after the caller decides to send. */
export function planCompanion(trigger: Trigger, library: FactoryLibrary | undefined): CompanionPlan | undefined {
  if (trigger.source !== SOURCE) return undefined
  const direct = trigger.meta.direct === true
  const userid = String(trigger.meta.userid ?? '')
  const chatId = String(trigger.meta.chatId ?? '')
  if (!library) {
    if (direct && factoryStart(trigger.text)) return { text: BOTFATHER_INIT }
    return { text: wecomCompanionText(trigger.text) }
  }
  const turn = botfatherTurn({
    direct, userid, text: trigger.text, route: library.route(),
    draft: userid ? library.draft(userid) : undefined, identities: library.identities(),
  })
  if (!turn.handled) return { text: wecomCompanionText(trigger.text, smokeFor(library.identities(), direct, chatId)) }
  return {
    text: turn.text,
    wired: turn.wired !== undefined,
    commit: () => {
      if (!userid) return
      if (turn.wired) library.saveIdentity(turn.wired)
      library.saveDraft(userid, turn.draft)
    },
  }
}
