/** Identity files, an open BotFather conversation, and the role package written beside them. */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { WECOM_ID } from '../sources/wecom-trigger.ts'
import { companionFragment, roleNote } from './grill.ts'
import { BotfatherRouteSchema, BusinessIdentitySchema, DEFAULT_ROUTE, FactoryDraftSchema, type BusinessIdentity, type FactoryDraft } from './schema.ts'
import { assertNoSecret } from './secrets.ts'
import { dumpYaml, parseYaml } from './yaml.ts'

export interface FactoryLibrary {
  identities(): BusinessIdentity[]
  route(): { ok: true; operators: string[] } | { ok: false }
  draft(userid: string): FactoryDraft | undefined
  saveDraft(userid: string, draft: FactoryDraft | null): void
  saveIdentity(identity: BusinessIdentity): void
}

/** Parses one identity file. A credential assignment is refused before the text is kept. */
export function parseIdentityFile(text: string): BusinessIdentity {
  if (/WECOM_BOT_SECRET\s*[:=]/i.test(text) || /(^|\n)\s*secret\s*:/i.test(text)) throw new Error('身份文件里不能写 Secret')
  assertNoSecret(text)
  return BusinessIdentitySchema.parse(document(text))
}

function document(text: string): unknown {
  const trimmed = text.trim()
  if (trimmed.startsWith('{')) return JSON.parse(trimmed) as unknown
  return parseYaml(text)
}

export function loadIdentities(dir: string): BusinessIdentity[] {
  let names: string[]
  try { names = readdirSync(dir) } catch { return [] }
  const identities: BusinessIdentity[] = []
  for (const name of names) {
    if (!/\.(yml|yaml|json)$/.test(name)) continue
    try {
      const parsed = BusinessIdentitySchema.parse(document(readFileSync(join(dir, name), 'utf8')))
      identities.push(parsed)
    } catch { /* One bad file does not hide the lines that parse. */ }
  }
  return identities
}

function routePath(identitiesDir: string): string {
  return join(dirname(identitiesDir), 'botfather.yml')
}

export function loadRoute(identitiesDir: string): { ok: true; operators: string[] } | { ok: false } {
  const path = routePath(identitiesDir)
  try {
    const parsed = BotfatherRouteSchema.parse(document(readFileSync(path, 'utf8')))
    return { ok: true, operators: parsed.operators }
  } catch (error) {
    const missing = error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT'
    return missing ? { ok: true, operators: [] } : { ok: false }
  }
}

function draftPath(dir: string, userid: string): string | undefined {
  if (!WECOM_ID.test(userid) || userid === '.' || userid === '..') return undefined
  return join(dir, `${userid}.json`)
}

/** Reads and writes the profile directory BotFather owns. `identitiesDir` is `<profile>/botfactory/identities`. */
export function openFactory(identitiesDir: string): FactoryLibrary {
  const root = dirname(identitiesDir)
  const drafts = join(root, 'drafts')
  const companions = join(root, 'companions')
  return {
    identities: () => loadIdentities(identitiesDir),
    route: () => loadRoute(identitiesDir),
    draft(userid) {
      const path = draftPath(drafts, userid)
      if (!path) return undefined
      try { return FactoryDraftSchema.parse(JSON.parse(readFileSync(path, 'utf8')) as unknown) } catch { return undefined }
    },
    saveDraft(userid, draft) {
      const path = draftPath(drafts, userid)
      if (!path) return
      if (!draft) { rmSync(path, { force: true }); return }
      mkdirSync(drafts, { recursive: true })
      writeFileSync(path, `${JSON.stringify(draft, null, 2)}\n`)
    },
    saveIdentity(identity) {
      const roles = join(root, 'roles')
      mkdirSync(identitiesDir, { recursive: true })
      mkdirSync(companions, { recursive: true })
      mkdirSync(roles, { recursive: true })
      const body = dumpYaml(identity)
      writeFileSync(join(identitiesDir, `${identity.id}.yml`), body)
      writeFileSync(join(companions, `${identity.id}.md`), companionFragment(identity))
      writeFileSync(join(roles, `${identity.id}.md`), roleNote(identity))
    },
  }
}

export function ensureRoute(identitiesDir: string): void {
  mkdirSync(identitiesDir, { recursive: true })
  const path = routePath(identitiesDir)
  try {
    if (readFileSync(path, 'utf8').trim()) return
  } catch { /* Missing route file gets the default DM factory. */ }
  writeFileSync(path, dumpYaml(DEFAULT_ROUTE))
}
