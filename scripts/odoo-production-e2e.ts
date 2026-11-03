/**
 * Live production-progress path without a Harness Session: poll an activity on a manufacturing
 * order, read its snapshot, and post one internal chase note.
 *
 * Skips with exit 0 when Odoo credentials are missing, manufacturing is not installed, no
 * manufacturing order exists, or the only activity would be the agent's own and no requester
 * login is set. `--dry-run` skips without calling Odoo.
 *
 *   ODOO_URL=http://127.0.0.1:8069 ODOO_DB=odoo ODOO_USER=… ODOO_PASSWORD=… \
 *     ODOO_REQUESTER_USER=… ODOO_REQUESTER_PASSWORD=… \
 *     node --experimental-transform-types scripts/odoo-production-e2e.ts
 *
 * `--mo`, `--activity` and `--after-id` select an order and an activity that already exist.
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
import { odooExecutorTools } from '../src/app/tools/odoo.ts'
import { odooKind, pollActivities } from '../src/sources/odoo.ts'
import { modelUnavailable, odooEnv, odooRpc } from '../src/sources/odoo-rpc.ts'
import { MRP_READ_FIELDS } from '../src/sources/odoo-trigger.ts'
import { testDeployment } from '../tests/fixtures/deployment.ts'

const MODEL = 'mrp.production'
const DRY = process.argv.includes('--dry-run')

function skip(reason: string): never {
  console.log(JSON.stringify({ skipped: true, reason }, null, 2))
  process.exit(0)
}

function flag(name: string): number | undefined {
  const index = process.argv.indexOf(`--${name}`)
  if (index < 0) return undefined
  const value = Number(process.argv[index + 1])
  if (!Number.isInteger(value) || value < 0) throw new Error(`--${name} must be a non-negative integer`)
  return value
}

function many2one(value: unknown): number | undefined {
  if (typeof value === 'number') return value
  return Array.isArray(value) && typeof value[0] === 'number' ? value[0] : undefined
}

if (DRY) skip('dry-run: would poll an mrp.production activity, read the snapshot, and post one internal note')
const env = odooEnv()
if (!env) skip('Set ODOO_DB, ODOO_USER and ODOO_PASSWORD (ODOO_URL defaults to http://127.0.0.1:8069)')

const rpc = odooRpc()
const agentUid = await rpc.uid()
try {
  await rpc.fieldsGet(MODEL)
} catch (error) {
  if (modelUnavailable(error)) skip('mrp.production is not installed; crm.lead activities still poll. Nothing to chase.')
  throw error
}

const requestedMo = flag('mo')
const orders = await rpc.searchRead(MODEL, requestedMo ? [['id', '=', requestedMo]] : [], { fields: ['id', 'name'], limit: 1, order: 'id desc' })
const order = orders[0]
if (!order || typeof order.id !== 'number') skip(requestedMo ? `Manufacturing order ${requestedMo} was not found` : 'No manufacturing order to attach an activity to')
const moId = order.id

const requestedActivity = flag('activity')
let activityId = requestedActivity
let creator = 0
if (activityId === undefined) {
  const rows = await rpc.searchRead('mail.activity', [['res_model', '=', MODEL], ['res_id', '=', moId], ['user_id', '=', agentUid]], {
    fields: ['id', 'create_uid', 'user_id'], limit: 5, order: 'id desc',
  })
  const other = rows.find(row => many2one(row.create_uid) !== agentUid && typeof row.id === 'number')
  if (other && typeof other.id === 'number') {
    activityId = other.id
    creator = many2one(other.create_uid) ?? 0
  }
}
if (activityId === undefined) {
  const requesterUser = process.env.ODOO_REQUESTER_USER?.trim() ?? ''
  const requesterPassword = process.env.ODOO_REQUESTER_PASSWORD ?? ''
  if (!requesterUser || !requesterPassword) {
    skip('No manufacturing activity from another user. Pass --activity, or set ODOO_REQUESTER_USER and ODOO_REQUESTER_PASSWORD to create one. The agent ignores an activity it created itself.')
  }
  const requester = odooRpc({ ...process.env, ODOO_USER: requesterUser, ODOO_PASSWORD: requesterPassword })
  const requesterUid = await requester.uid()
  if (requesterUid === agentUid) skip('ODOO_REQUESTER_USER is the agent user. An activity the agent creates is ignored.')
  const types = await rpc.searchRead('mail.activity.type', [], { fields: ['id'], limit: 1, order: 'id asc' })
  const activityType = types[0]?.id
  if (typeof activityType !== 'number') skip('No mail.activity.type to attach a chase activity to')
  activityId = await requester.create('mail.activity', {
    res_model: MODEL, res_id: moId, user_id: agentUid, activity_type_id: activityType,
    summary: 'Chase production progress', date_deadline: new Date().toISOString().slice(0, 10),
  })
  creator = requesterUid
}

const loaded = await rpc.searchRead('mail.activity', [['id', '=', activityId]], {
  fields: ['id', 'res_model', 'res_id', 'summary', 'user_id', 'create_uid'], limit: 1,
})
const row = loaded[0]
if (!row || row.res_model !== MODEL || row.res_id !== moId) throw new Error(`Activity ${activityId} is not on manufacturing order ${moId}`)
creator = creator || many2one(row.create_uid) || 0
const assignee = many2one(row.user_id)
if (creator === agentUid) throw new Error(`Activity ${activityId} was created by the agent and will be ignored`)
if (!creator || assignee !== agentUid) throw new Error(`Activity ${activityId} is not assigned to the agent (${agentUid})`)

const after = flag('after-id') ?? activityId - 1
const directory = mkdtempSync(join(tmpdir(), 'odoo-production-e2e-'))
const store = new Store(join(directory, 'db.sqlite'))
store.saveSettings(SettingsSchema.parse({
  eval: { mode: 'auto' },
  sources: { odoo: { enabled: true, config: {} } },
  policy: { sources: { odoo: { allowed: [{ id: String(creator), name: 'Requester' }] } } },
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
store.set(KV.odoo.activity, { afterId: after })
const signal = new AbortController().signal
const polled = await pollActivities(ctx, rpc, signal)
const triggerId = key('odoo', 'activity', String(activityId))
const trigger = store.triggers.get(triggerId)
if (!trigger) throw new Error(`Poll did not store activity ${activityId}: ${JSON.stringify(polled)}`)
const candidate = engine.candidate(triggerId)
const decision = engine.decide(triggerId, {
  kind: 'accept', title: 'Chase production progress', scope: 'Read the manufacturing order and post one internal chase note',
  reason: 'Allowed user assigned the activity to the agent', name: 'chase-production-progress',
})
const ticket = decision.ticketId ? store.tickets.get(decision.ticketId) : undefined
if (!ticket) throw new Error(`Engine did not open a ticket: ${decision.kind}`)
const tools = odooExecutorTools({ store }, ticket, () => rpc)
const readTool = tools.find(tool => tool.name === 'odoo_search_read')
const postTool = tools.find(tool => tool.name === 'odoo_message_post')
if (!readTool || !postTool || tools.some(tool => tool.name === 'odoo_write')) throw new Error('Manufacturing tickets expose a snapshot read and a note, not a field write')
const read = await readTool.execute(readTool.schema.parse({ model: MODEL, fields: [...MRP_READ_FIELDS] }), signal) as { progress?: { signal?: string } }
const body = `Progress check on ${String(order.name ?? moId)}: snapshot signal ${read.progress?.signal ?? 'unavailable'}. No date change.`
const posted = await postTool.execute(postTool.schema.parse({ model: MODEL, body }), signal)
const notes = await rpc.searchRead('mail.message', [['model', '=', MODEL], ['res_id', '=', moId], ['body', 'ilike', 'Progress check']], {
  fields: ['id', 'body'], limit: 3, order: 'id desc',
})
store.close()
rmSync(directory, { recursive: true, force: true })
console.log(JSON.stringify({
  agentUid, requester: creator, moId, order: order.name ?? null, activityId, afterId: after,
  polled, triggerId, thread: trigger.threads[0]?.id ?? null, strength: candidate?.strength ?? null,
  decision: decision.kind, ticketId: ticket.id, executorStarted: started,
  tools: tools.map(tool => tool.name), read, posted,
  notes: notes.map(note => ({ id: note.id, body: note.body })),
}, null, 2))
