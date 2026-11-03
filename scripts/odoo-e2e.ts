/**
 * Live Odoo path without a Harness Session: XML-RPC poll → Engine ticket → the three worker tools.
 *
 * A cold poll only records the current highest activity id and emits nothing. Pass `--after-id`
 * as the cursor a Source that was already running would hold (one less than the activity to ingest).
 *
 *   ODOO_URL=http://127.0.0.1:8069 ODOO_DB=odoo ODOO_USER=… ODOO_PASSWORD=… \
 *     node --experimental-transform-types scripts/odoo-e2e.ts --after-id 3 --activity 4 --lead 7
 *
 * The password is read from the environment and is not printed.
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Engine, key, type Assessor, type Executor, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { Store } from '../src/app/store.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { OdooMessagePostSchema, OdooSearchReadSchema, OdooWriteSchema, odooExecutorTools } from '../src/app/tools/odoo.ts'
import { pollActivities } from '../src/sources/odoo.ts'
import { odooKind } from '../src/sources/odoo.ts'
import { odooEnv, odooRpc } from '../src/sources/odoo-rpc.ts'
import { activityDomain } from '../src/sources/odoo-trigger.ts'
import { testDeployment } from '../tests/fixtures/deployment.ts'

const ACTIVITY = flag('activity', 4)
const LEAD = flag('lead', 7)
const AFTER = flag('after-id', 3)
const ALLOWED = '5'

function flag(name: string, fallback: number): number {
  const index = process.argv.indexOf(`--${name}`)
  const value = index >= 0 ? Number(process.argv[index + 1]) : fallback
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`)
  return value
}

function stated(text: string): { phone?: string; email_from?: string; contact_name?: string } {
  const phone = /phone\s+([0-9][0-9-]*)/i.exec(text)?.[1]
  const email = /email\s+(\S+)/i.exec(text)?.[1]?.replace(/[,.]$/, '')
  const contact = /contact\s+([^,\n]+)/i.exec(text)?.[1]?.trim()
  return { ...(phone ? { phone } : {}), ...(email ? { email_from: email } : {}), ...(contact ? { contact_name: contact } : {}) }
}

const env = odooEnv()
if (!env) throw new Error('Set ODOO_DB, ODOO_USER and ODOO_PASSWORD')
const rpc = odooRpc()
const agentUid = await rpc.uid()
const before = await rpc.searchRead('crm.lead', [['id', '=', LEAD]], { fields: ['id', 'name', 'phone', 'email_from', 'contact_name'], limit: 1 })
const activity = await rpc.searchRead('mail.activity', [['id', '=', ACTIVITY]], {
  fields: ['id', 'res_model', 'res_id', 'summary', 'user_id', 'create_uid'], limit: 1,
})
const row = activity[0]
if (!row || row.res_id !== LEAD) throw new Error(`Activity ${ACTIVITY} is not on lead ${LEAD}`)
const creator = Array.isArray(row.create_uid) ? row.create_uid[0] : row.create_uid
const assignee = Array.isArray(row.user_id) ? row.user_id[0] : row.user_id
if (creator !== Number(ALLOWED) || assignee !== agentUid) {
  throw new Error(`Activity ${ACTIVITY} is not from user ${ALLOWED} to the agent (${agentUid})`)
}

const directory = mkdtempSync(join(tmpdir(), 'odoo-e2e-'))
const store = new Store(join(directory, 'db.sqlite'))
store.saveSettings(SettingsSchema.parse({
  eval: { mode: 'auto' },
  sources: { odoo: { enabled: true, config: {} } },
  policy: { sources: { odoo: { allowed: [{ id: ALLOWED, name: 'Requester' }] } } },
}))
const sources = new SourceRegistry(() => store.settings(), new HealthBoard())
sources.register(odooKind)
const started: string[] = []
const assessor: Assessor = { request: () => {} }
const executor: Executor = { start: ticket => { started.push(ticket.id) }, deliver: () => {}, stop: () => {} }
const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
  outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
const deployment = testDeployment()
const commands = new Commands(() => deployment, {}, new AbortController().signal)
const receive = (trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result }
const deps: SourceContextDeps = { store, engine, outbox: { send: () => {} }, commands, sources, deployment,
  ready: Promise.resolve(), configured: () => true, receive }
const ctx = sourceContextOf(deps, odooKind)
store.set(KV.odoo.activity, { afterId: AFTER })
const polled = await pollActivities(ctx, rpc, new AbortController().signal)
const triggerId = key('odoo', 'activity', String(ACTIVITY))
const trigger = store.triggers.get(triggerId)
if (!trigger) throw new Error(`Poll did not store activity ${ACTIVITY}: ${JSON.stringify(polled)} domain ${JSON.stringify(activityDomain(AFTER, agentUid))}`)
const candidate = engine.candidate(triggerId)
const decision = engine.decide(triggerId, {
  kind: 'accept', title: 'Fill the lead contact', scope: 'Fill the contact fields the activity states',
  reason: 'Allowed user assigned the activity to the agent', name: 'fill-lead-contact',
})
const ticket = decision.ticketId ? store.tickets.get(decision.ticketId) : undefined
if (!ticket) throw new Error(`Engine did not open a ticket: ${decision.kind}`)
const tools = odooExecutorTools({ store }, ticket, () => rpc)
const signal = new AbortController().signal
const read = await tools.find(tool => tool.name === 'odoo_search_read')!.execute(OdooSearchReadSchema.parse({
  fields: ['id', 'name', 'phone', 'email_from', 'contact_name'],
}), signal)
const values = stated(trigger.text)
if (!values.phone || !values.email_from || !values.contact_name) throw new Error(`Activity text did not state phone, email and contact: ${trigger.text}`)
const wrote = await tools.find(tool => tool.name === 'odoo_write')!.execute(OdooWriteSchema.parse({ values }), signal)
const body = `Filled phone ${values.phone}, email ${values.email_from}, and contact ${values.contact_name}.`
const posted = await tools.find(tool => tool.name === 'odoo_message_post')!.execute(OdooMessagePostSchema.parse({ body }), signal)
const lead = await rpc.searchRead('crm.lead', [['id', '=', LEAD]], { fields: ['id', 'name', 'phone', 'email_from', 'contact_name'], limit: 1 })
const notes = await rpc.searchRead('mail.message', [['model', '=', 'crm.lead'], ['res_id', '=', LEAD], ['body', 'ilike', values.phone!]], {
  fields: ['id', 'body'], limit: 5, order: 'id desc',
})
store.close()
rmSync(directory, { recursive: true, force: true })
console.log(JSON.stringify({
  agentUid, allowed: ALLOWED, afterId: AFTER, domain: activityDomain(AFTER, agentUid),
  before: before[0] ?? null, polled, triggerId, strength: candidate?.strength ?? null,
  decision: decision.kind, ticketId: ticket.id, executorStarted: started, read, wrote, posted,
  lead: lead[0] ?? null,
  notes: notes.map(note => ({ id: note.id, body: note.body })),
}, null, 2))
