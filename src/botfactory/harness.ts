/** Hands a BotFather direct message to the session, and writes the template once that session settles it. */
import type { Trigger } from '../core/index.ts'
import { checkedImText } from '../infra/text.ts'
import type { Settings } from '../policy.ts'
import { SOURCE as FEISHU } from '../sources/feishu-trigger.ts'
import { SOURCE as WECOM } from '../sources/wecom-trigger.ts'
import { chatConflict, factoryStart, factoryStop, hangNotice, identityId } from './grill.ts'
import { BusinessIdentitySchema, type BusinessIdentity, type FactoryDraft } from './schema.ts'
import { openFactory, type FactoryLibrary } from './store.ts'

const FIELDS = ['id', 'name', 'persona', 'scope', 'autoReply', 'autoAdvance', 'humanApprove', 'formatter', 'escalation', 'erp', 'smoke', 'permissions'] as const

export function remember(draft: FactoryDraft | undefined, text: string, role: 'user' | 'assistant' = 'user'): FactoryDraft {
  const trimmed = text.trim().slice(0, 2000)
  const lines = [...draft?.lines ?? []]
  if (trimmed) lines.push({ role, text: trimmed })
  return { open: true, lines: lines.slice(-40) }
}

/** Draft file key. Feishu keeps its own file so it does not share a WeCom userid's conversation. */
export function factoryKey(trigger: Trigger): string {
  const userid = String(trigger.meta.userid ?? trigger.actor?.id ?? '')
  return trigger.source === FEISHU ? `feishu-${userid}` : userid
}

function configuredDir(settings: Settings, source: string): string | undefined {
  const dir = settings.sources[source]?.config.identitiesDir
  return typeof dir === 'string' && dir.trim() ? dir : undefined
}

export interface FactoryHandoff { lines: FactoryDraft['lines'] }

/**
 * The open conversation for a direct message the session should answer.
 * Absent when the host already replied: no directory, a broken route, a group, or someone outside the route.
 */
export function factoryHandoff(settings: Settings, trigger: Trigger): FactoryHandoff | undefined {
  if ((trigger.source !== WECOM && trigger.source !== FEISHU) || trigger.meta.direct !== true) return undefined
  const dir = configuredDir(settings, trigger.source)
  if (!dir) return undefined
  const library = openFactory(dir)
  const route = library.route()
  if (!route.ok) return undefined
  const userid = String(trigger.meta.userid ?? trigger.actor?.id ?? '')
  if (!userid || (route.operators.length > 0 && !route.operators.includes(userid))) return undefined
  const draft = library.draft(factoryKey(trigger))
  if (draft?.open && factoryStop(trigger.text)) return undefined
  if (!draft?.open && !factoryStart(trigger.text)) return undefined
  return { lines: draft?.lines ?? [] }
}

/** Checks a template. Fills the id from the name and keeps permissions deferred. Does not invent the line's work. */
export function settle(raw: unknown, existing: readonly BusinessIdentity[]): { identity: BusinessIdentity } | { error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'The identity has to be an object.' }
  const source = raw as Record<string, unknown>
  const body: Record<string, unknown> = {}
  for (const field of FIELDS) if (field in source) body[field] = source[field]
  if (typeof body.name === 'string' && typeof body.id !== 'string') body.id = identityId(body.name)
  body.permissions = 'deferred'
  const parsed = BusinessIdentitySchema.safeParse(body)
  if (!parsed.success) {
    const paths = parsed.error.issues.slice(0, 8).map(issue => issue.path.map(String).join('.') || issue.message)
    return { error: `The template is not ready: ${paths.join('; ')}` }
  }
  const conflict = chatConflict(existing, parsed.data)
  if (conflict) return { error: conflict }
  return { identity: parsed.data }
}

export interface BotfatherCall { text?: string; identity?: unknown; close?: boolean }
export interface BotfatherResult { say?: string; wired?: BusinessIdentity; hang?: string; closed?: boolean; error?: string }

/** Speaks, writes a settled template, or closes the conversation. A template that does not parse is not written. */
export function applyBotfather(library: FactoryLibrary, key: string, call: BotfatherCall): BotfatherResult {
  const text = call.text?.trim() ?? ''
  if (call.identity !== undefined) {
    if (!text) return { error: 'Say the template back in text, and pass the identity with it.' }
    const said = speech(text)
    if (typeof said !== 'string') return { error: said.error }
    const settled = settle(call.identity, library.identities())
    if ('error' in settled) return { error: settled.error }
    const hang = notice(settled.identity)
    if (typeof hang !== 'string') return { error: hang.error }
    library.saveIdentity(settled.identity)
    library.saveDraft(key, null)
    return { say: said, wired: settled.identity, hang }
  }
  if (call.close) {
    if (text) {
      const said = speech(text)
      if (typeof said !== 'string') return { error: said.error }
      library.saveDraft(key, null)
      return { say: said, closed: true }
    }
    library.saveDraft(key, null)
    return { closed: true }
  }
  if (!text) return { error: 'Say something, or pass the identity when the line is settled.' }
  const said = speech(text)
  if (typeof said !== 'string') return { error: said.error }
  const draft = library.draft(key)
  library.saveDraft(key, remember(draft?.open ? draft : undefined, said, 'assistant'))
  return { say: said }
}

function speech(text: string): string | { error: string } {
  try { return checkedImText(text) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

function notice(identity: BusinessIdentity): string | { error: string } {
  try { return hangNotice(identity) } catch (error) { return { error: error instanceof Error ? error.message : String(error) } }
}

/** The identity directory of the trigger's own Source, the one its draft was saved beside. */
export function factoryDir(settings: Settings, trigger: Trigger): string | undefined {
  return configuredDir(settings, trigger.source)
}
