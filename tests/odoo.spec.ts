/** Odoo Source: activity translation, poll cursor, configuration, channel notes, and the worker tools' arguments. */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Engine, key, type Assessor, type Executor, type Ticket, type Trigger } from '../src/core/index.ts'
import { Commands } from '../src/infra/commands.ts'
import { HealthBoard } from '../src/infra/health.ts'
import { KV } from '../src/kv.ts'
import { SettingsSchema, settingsPolicy } from '../src/policy.ts'
import { sourceContextOf, type SourceContextDeps } from '../src/app/source-context.ts'
import { Store } from '../src/app/store.ts'
import { OdooMessagePostSchema, OdooSearchReadSchema, OdooWriteSchema, odooExecutorTools, odooLead, type OdooToolsHost } from '../src/app/tools/odoo.ts'
import { noteHtml, odooMarker, postOdooNote, sendOdoo } from '../src/sources/odoo-channel.ts'
import { apply as applyOdoo, odooKind, optionalModelStatus, pollActivities, pollHealthDetail } from '../src/sources/odoo.ts'
import { classifyProduction } from '../src/sources/odoo-progress.ts'
import { OdooClient, modelUnavailable, odooRecordGone, setOdooTransport, type OdooRpc, type XmlRpcTransport } from '../src/sources/odoo-rpc.ts'
import { MRP_READ_FIELDS, ODOO_MODEL, SALE_READ_FIELDS, activityDomain, odooTrigger, type OdooActivity } from '../src/sources/odoo-trigger.ts'
import { OdooFault, decodeResponse, encodeCall, encodeValue } from '../src/sources/odoo-xml.ts'
import { SourceRegistry } from '../src/sources/registry.ts'
import { testDeployment } from './fixtures/deployment.ts'

const AGENT = 3
const ADA = 7
const saved = { ...process.env }

afterEach(() => {
  setOdooTransport(undefined)
  for (const name of ['ODOO_URL', 'ODOO_DB', 'ODOO_USER', 'ODOO_PASSWORD']) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
})

function activity(id: number, fields: Partial<OdooActivity> = {}): OdooActivity {
  return {
    id, res_model: ODOO_MODEL, res_id: 15, summary: 'Call Ada', note: '<p>Phone 555-0100</p>',
    user_id: [AGENT, 'Agent'], create_uid: [ADA, 'Ada'], create_date: '2026-11-04 03:54:00', ...fields,
  }
}

function host() {
  const directory = mkdtempSync(join(tmpdir(), 'odoo-'))
  const store = new Store(join(directory, 'db.sqlite'))
  store.saveSettings(SettingsSchema.parse({
    eval: { mode: 'auto' },
    sources: { odoo: { enabled: true, config: {} } },
    policy: { sources: { odoo: { allowed: [{ id: String(ADA), name: 'Ada' }] } } },
  }))
  const board = new HealthBoard()
  const sources = new SourceRegistry(() => store.settings(), board)
  sources.register(odooKind)
  const assessor: Assessor = { request: vi.fn(async () => {}) }
  const executor: Executor = { start: vi.fn(async () => {}), deliver: vi.fn(async () => {}), stop: vi.fn(async () => {}) }
  const engine = new Engine({ repo: store, scope: sources, policy: () => settingsPolicy(store.settings(), sources), assessor, executor,
    outbox: { send: () => {}, status: () => undefined, withdraw: () => {} } })
  const deployment = testDeployment()
  const commands = new Commands(() => deployment, {}, new AbortController().signal)
  const receive = vi.fn((trigger: Trigger) => { const result = engine.receive(trigger); engine.evaluateDue(); return result })
  const deps: SourceContextDeps = { store, engine, outbox: { send: message => { store.receipts.add(message) } }, commands, sources, deployment,
    ready: Promise.resolve(), configured: () => true, receive }
  const close = () => { store.close(); rmSync(directory, { recursive: true, force: true }) }
  return { store, engine, sources, receive, health: board.all, ctx: sourceContextOf(deps, odooKind), close, deps }
}

function fakeRpc(search: (model: string, domain: readonly unknown[]) => Record<string, unknown>[] = () => []): { rpc: OdooRpc; calls: { method: string; args: unknown[] }[] } {
  const calls: { method: string; args: unknown[] }[] = []
  const rpc: OdooRpc = {
    uid: async () => AGENT,
    searchRead: async (model, domain, options) => { calls.push({ method: 'search_read', args: [model, domain, options] }); return search(model, domain) },
    fieldsGet: async model => {
      calls.push({ method: 'fields_get', args: [model] })
      const names = model === 'mrp.production' ? MRP_READ_FIELDS : model === 'sale.order' ? SALE_READ_FIELDS : ['id', 'name']
      return Object.fromEntries(names.map(name => [name, { type: 'char' }]))
    },
    write: async (model, ids, values) => { calls.push({ method: 'write', args: [model, ids, values] }); return true },
    messagePost: async (model, id, body) => { calls.push({ method: 'message_post', args: [model, id, body] }); return 90 },
    create: async (model, values) => { calls.push({ method: 'create', args: [model, values] }); return 1 },
  }
  return { rpc, calls }
}

describe('odoo trigger', () => {
  it('maps an activity assigned to the agent onto one lead thread and drops the agent\'s own', () => {
    const trigger = odooTrigger(activity(41), AGENT, 'http://127.0.0.1:8069')
    expect(trigger).toMatchObject({
      id: key('odoo', 'activity', '41'), source: 'odoo', threads: [{ source: 'odoo', id: 'crm.lead:15' }],
      actor: { source: 'odoo', id: '7' }, human: true, addressed: 'direct', at: '2026-11-04T03:54:00.000Z',
      text: 'Call Ada\nPhone 555-0100',
      channel: { source: 'odoo', thread: 'odoo:crm.lead:15', address: { model: 'crm.lead', res_id: '15' } },
      url: 'http://127.0.0.1:8069/web#id=15&model=crm.lead&view_type=form',
      meta: { model: 'crm.lead', resId: 15, activityId: 41, userId: AGENT, createUid: ADA },
    })
    expect(odooTrigger(activity(41), AGENT, 'http://127.0.0.1:8069')?.id).toBe(trigger?.id)
    expect(odooTrigger(activity(41, { create_uid: [AGENT, 'Agent'] }), AGENT, '')).toBeUndefined()
    expect(odooTrigger(activity(41, { create_uid: false }), AGENT, '')).toBeUndefined()
    expect(odooTrigger(activity(41, { user_id: [9, 'Someone'] }), AGENT, '')?.addressed).toBeUndefined()
    expect(odooTrigger(activity(50, { res_model: 'mrp.production', res_id: 8 }), AGENT, 'http://127.0.0.1:8069')).toMatchObject({
      id: key('odoo', 'activity', '50'), threads: [{ source: 'odoo', id: 'mrp.production:8' }],
      channel: { source: 'odoo', thread: 'odoo:mrp.production:8', address: { model: 'mrp.production', res_id: '8' } },
      url: 'http://127.0.0.1:8069/web#id=8&model=mrp.production&view_type=form',
      meta: { model: 'mrp.production', resId: 8, activityId: 50 },
    })
    expect(odooTrigger(activity(51, { res_model: 'sale.order', res_id: 4 }), AGENT, '')?.threads).toEqual([{ source: 'odoo', id: 'sale.order:4' }])
    expect(activityDomain(10, AGENT)).toEqual([['id', '>', 10], ['res_model', 'in', ['crm.lead', 'mrp.production', 'sale.order']], ['user_id', '=', AGENT]])
  })

  it('listens to leads, manufacturing orders and sales orders', () => {
    expect(odooKind.schema.parse({})).toEqual({ pollSeconds: 30, failuresBeforeError: 3 })
    expect(() => odooKind.schema.parse({ pollSeconds: 5 })).toThrow()
    expect(odooKind.scope!({ meta: { model: 'crm.lead' } }, odooKind.schema.parse({}))).toEqual({ listened: true, observed: false, row: 'crm.lead' })
    expect(odooKind.scope!({ meta: { model: 'mrp.production' } }, odooKind.schema.parse({}))).toEqual({ listened: true, observed: false, row: 'mrp.production' })
    expect(odooKind.scope!({ meta: { model: 'sale.order' } }, odooKind.schema.parse({}))).toEqual({ listened: true, observed: false, row: 'sale.order' })
    expect(odooKind.scope!({ meta: { model: 'res.partner' } }, odooKind.schema.parse({}))).toEqual({ listened: false, reason: 'model_not_allowed' })
    expect(odooKind.policy!.schema.parse({})).toEqual({ allowed: [] })
    expect(() => odooKind.policy!.schema.parse({ allowed: [{ id: 'ada' }] })).toThrow()
    const cells = { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false }
    const note = { zh: '仅指派给智能体的活动', en: 'Activities assigned to the agent' }
    expect(odooKind.policy!.rows!({})).toEqual([
      { id: 'crm.lead', label: { zh: 'CRM 线索', en: 'CRM leads' }, note, cells },
      { id: 'mrp.production', label: { zh: '制造订单', en: 'Manufacturing orders' }, note, cells },
      { id: 'sale.order', label: { zh: '销售订单', en: 'Sales orders' }, note, cells },
    ])
    expect(odooKind.find!('see crm.lead/15 please').threads).toEqual(['odoo:crm.lead:15'])
    expect(odooKind.find!('mrp.production:8').threads).toEqual(['odoo:mrp.production:8'])
    expect(odooKind.environment!.values({ deployment: testDeployment(), config: odooKind.schema.parse({}), trigger: odooTrigger(activity(41), AGENT, '') })).toMatchObject({
      DSH_SUPERAGENT_ODOO_MODEL: 'crm.lead', DSH_SUPERAGENT_ODOO_RES_ID: '15', DSH_SUPERAGENT_ODOO_ACTIVITY: '41',
    })
    expect(odooKind.environment!.values({ deployment: testDeployment(), config: odooKind.schema.parse({}) }).DSH_SUPERAGENT_ODOO_RES_ID).toBe('')
  })
})

describe('odoo poll', () => {
  it('primes the cursor, then takes each new activity once', async () => {
    const h = host()
    const seen: Record<string, unknown>[][] = [[{ id: 10 }], [activity(11), { id: 12 }, activity(13, { res_model: 'res.partner', res_id: 4 })]]
    const { rpc } = fakeRpc(() => seen.shift() ?? [])
    expect(await pollActivities(h.ctx, rpc, new AbortController().signal)).toMatchObject({ primed: true, afterId: 10, read: 0 })
    expect(h.store.get(KV.odoo.activity)).toEqual({ afterId: 10 })
    expect(h.receive).not.toHaveBeenCalled()
    const round = await pollActivities(h.ctx, rpc, new AbortController().signal)
    expect(round).toMatchObject({ read: 3, unreadable: 1, afterId: 13 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(await h.receive.mock.results[1]!.value).toBe('filtered')
    expect(h.engine.candidate(key('odoo', 'activity', '11'))?.strength).toBe('explicit')
    expect(h.store.threads.get('odoo:crm.lead:15')?.meta.label).toBe('Lead 15')
    await pollActivities(h.ctx, fakeRpc(() => [activity(11)]).rpc, new AbortController().signal)
    expect(await h.receive.mock.results[2]!.value).toBe('duplicate')
    h.close()
  })

  it('keeps the cursor when a later activity fails to be stored', async () => {
    const h = host()
    h.store.set(KV.odoo.activity, { afterId: 10 })
    const { rpc, calls } = fakeRpc(() => [activity(11), activity(12, { res_id: 16 })])
    h.receive.mockImplementation((trigger: Trigger) => {
      if (trigger.meta.activityId === 12) throw new Error('disk full')
      return h.engine.receive(trigger)
    })
    await expect(pollActivities(h.ctx, rpc, new AbortController().signal)).rejects.toThrow('disk full')
    expect(h.store.get(KV.odoo.activity)).toEqual({ afterId: 11 })
    expect(calls[0]!.args[1]).toEqual(activityDomain(10, AGENT))
    h.close()
  })

  it('stores a manufacturing activity on that order\'s thread', async () => {
    const h = host()
    h.store.set(KV.odoo.activity, { afterId: 10 })
    const round = await pollActivities(h.ctx, fakeRpc(() => [activity(14, { res_model: 'mrp.production', res_id: 8 })]).rpc, new AbortController().signal)
    expect(round).toMatchObject({ read: 1, unreadable: 0, afterId: 14 })
    expect(await h.receive.mock.results[0]!.value).toBe('stored')
    expect(h.engine.candidate(key('odoo', 'activity', '14'))?.strength).toBe('explicit')
    expect(h.store.threads.get('odoo:mrp.production:8')?.meta.label).toBe('Manufacturing order 8')
    h.close()
  })
})

describe('odoo channel', () => {
  it('posts a note once and answers gone only when the lead is gone', async () => {
    const first = fakeRpc()
    expect(await postOdooNote(first.rpc, 'crm.lead', 15, 'Filled phone.', odooMarker('m1'))).toBe('sent')
    expect(first.calls.map(call => call.method)).toEqual(['search_read', 'message_post'])
    expect(String(first.calls[1]!.args[2])).toContain('dsh-superagent:m1')
    expect(noteHtml('a&b<c>')).toBe('<p>a&amp;b&lt;c&gt;</p>')
    const again = fakeRpc(() => [{ id: 5 }])
    expect(await postOdooNote(again.rpc, 'crm.lead', 15, 'Filled phone.', odooMarker('m1'))).toBe('sent')
    expect(again.calls.map(call => call.method)).toEqual(['search_read'])
    const gone = fakeRpc()
    gone.rpc.searchRead = async () => { throw new OdooFault(1, 'Record does not exist or has been deleted.') }
    expect(await postOdooNote(gone.rpc, 'crm.lead', 15, 'Filled phone.', 'dsh-superagent:m2')).toBe('gone')
    expect(odooRecordGone(new OdooFault(2, 'connection reset'))).toBe(false)
    const refused = fakeRpc()
    refused.rpc.messagePost = async () => { throw new OdooFault(1, 'connection reset') }
    await expect(postOdooNote(refused.rpc, 'crm.lead', 15, 'Filled phone.', undefined)).rejects.toThrow('connection reset')
    await expect(sendOdoo({ commands: {} as Commands }, { id: 'm', kind: 'reply', text: 'hi', channel: { source: 'odoo', thread: 'odoo:crm.lead:0', address: { model: 'crm.lead', res_id: '0' } } })).rejects.toThrow('Missing Odoo reply target')
    const config = odooKind.schema.parse({})
    expect(odooKind.channel?.allowed?.({ model: 'crm.lead', res_id: '15' }, config)).toBe(true)
    expect(odooKind.channel?.allowed?.({ model: 'mrp.production', res_id: '8' }, config)).toBe(true)
    expect(odooKind.channel?.allowed?.({ model: 'sale.order', res_id: '15' }, config)).toBe(true)
    expect(odooKind.channel?.allowed?.({ model: 'res.partner', res_id: '15' }, config)).toBe(false)
    expect(odooKind.channel!.link({ model: 'crm.lead', res_id: '15' }, {}).url).toBe('http://127.0.0.1:8069/web#id=15&model=crm.lead&view_type=form')
    expect(odooKind.channel!.link({ model: 'mrp.production', res_id: '8' }, {}).label).toEqual({ zh: 'Odoo 制造订单 8', en: 'Odoo manufacturing order 8' })
  })
})

describe('odoo tools', () => {
  const trigger = odooTrigger(activity(41), AGENT, '')!
  const ticket = { origin: { triggerId: trigger.id } } as Ticket
  function toolsHost(): { host: OdooToolsHost; calls: { method: string; args: unknown[] }[]; rpc: () => OdooRpc } {
    const { rpc, calls } = fakeRpc(model => model === 'crm.lead' ? [{ id: 15, phone: false, email_from: 'ada@example.com' }] : [])
    return { calls, rpc: () => rpc, host: { store: { triggers: { get: id => id === trigger.id ? trigger : undefined } } } }
  }

  it('rejects fields and models outside the lead whitelist', () => {
    expect(OdooSearchReadSchema.safeParse({ model: 'res.partner' }).success).toBe(false)
    expect(OdooSearchReadSchema.safeParse({ fields: ['stage_id'] }).success).toBe(false)
    expect(OdooWriteSchema.safeParse({ values: { phone: '555-0100', stage_id: '2' } }).success).toBe(false)
    expect(OdooWriteSchema.safeParse({ values: { user_id: 1 } }).success).toBe(false)
    expect(OdooMessagePostSchema.safeParse({ body: '   ' }).success).toBe(false)
    expect(OdooSearchReadSchema.parse({}).model).toBe('crm.lead')
  })

  it('reads, writes and posts only the ticket\'s lead', async () => {
    const host = toolsHost()
    const tools = odooExecutorTools(host.host, ticket, host.rpc)
    expect(tools.map(item => item.name)).toEqual(['odoo_search_read', 'odoo_write', 'odoo_message_post'])
    const read = await tools[0]!.execute(OdooSearchReadSchema.parse({ fields: ['phone', 'email_from'] }), new AbortController().signal) as { records: unknown[] }
    expect(read.records).toEqual([{ phone: null, email_from: 'ada@example.com' }])
    expect(host.calls[0]!.args[1]).toEqual([['id', '=', 15]])
    await tools[1]!.execute(OdooWriteSchema.parse({ values: { phone: '555-0100', description: 'Known\ncontact' } }), new AbortController().signal)
    expect(host.calls[1]!.args[2]).toEqual({ phone: '555-0100', description: '<p>Known<br>contact</p>' })
    await expect(tools[1]!.execute(OdooWriteSchema.parse({ values: {} }), new AbortController().signal)).rejects.toThrow(/values needs/)
    const posted = await tools[2]!.execute(OdooMessagePostSchema.parse({ body: 'Filled phone. Email was already set.' }), new AbortController().signal) as { message_id: number }
    expect(posted).toEqual({ model: 'crm.lead', res_id: 15, message_id: 90 })
    expect(odooExecutorTools({ store: { triggers: { get: () => undefined } } }, ticket)).toEqual([])
    expect(() => odooLead({ store: { triggers: { get: () => ({ ...trigger, source: 'github' }) } } }, ticket)).toThrow('did not start on Odoo')
  })

  it('reads a manufacturing snapshot, skips a missing field, and does not offer a field write', async () => {
    const trigger = odooTrigger(activity(41, { res_model: 'mrp.production', res_id: 8, summary: 'Chase', note: false }), AGENT, '')!
    const moTicket = { origin: { triggerId: trigger.id } } as Ticket
    const host = toolsHost()
    host.rpc = () => {
      const { rpc } = fakeRpc(() => [{ id: 8, name: 'WH/MO/1', state: 'progress', date_deadline: '2020-01-01', product_qty: 10, qty_produced: 3, product_id: [4, 'Cabinet'] }])
      rpc.fieldsGet = async () => Object.fromEntries(MRP_READ_FIELDS.filter(field => field !== 'date_finished').map(field => [field, { type: 'char' }]))
      return rpc
    }
    host.host = { store: { triggers: { get: id => id === trigger.id ? trigger : undefined } } }
    const tools = odooExecutorTools(host.host, moTicket, host.rpc)
    expect(tools.map(item => item.name)).toEqual(['odoo_search_read', 'odoo_message_post'])
    expect(tools[0]!.schema.safeParse({ fields: ['stage_id'] }).success).toBe(false)
    expect(tools[0]!.schema.safeParse({ model: 'crm.lead' }).success).toBe(false)
    const read = await tools[0]!.execute(tools[0]!.schema.parse({}), new AbortController().signal) as { skipped: string[]; progress: { signal: string; attention: string }; records: unknown[] }
    expect(read.skipped).toEqual(['date_finished'])
    expect(read.records).toEqual([{ id: 8, name: 'WH/MO/1', state: 'progress', date_deadline: '2020-01-01', product_qty: 10, qty_produced: 3, product_id: [4, 'Cabinet'] }])
    expect(read.progress.signal).toBe('shortfall')
    expect(read.progress.attention).toContain('升级缺料异常')
    expect(read.progress.attention.length).toBeLessThanOrEqual(1000)
    const posted = await tools[1]!.execute(tools[1]!.schema.parse({ body: 'Chasing WH/MO/1.' }), new AbortController().signal)
    expect(posted).toEqual({ model: 'mrp.production', res_id: 8, message_id: 90 })
    expect(() => odooLead(host.host, moTicket)).toThrow('no crm.lead')
    const missing = fakeRpc()
    missing.rpc.fieldsGet = async () => { throw new OdooFault(1, "Object mrp.production doesn't exist") }
    const again = odooExecutorTools(host.host, moTicket, () => missing.rpc)
    expect(await again[0]!.execute(again[0]!.schema.parse({}), new AbortController().signal)).toMatchObject({ model: 'mrp.production', unavailable: true, res_id: 8 })
  })

  it('reads a sales order and does not offer a field write', () => {
    const sale = odooTrigger(activity(60, { res_model: 'sale.order', res_id: 4 }), AGENT, '')!
    const tools = odooExecutorTools({ store: { triggers: { get: () => sale } } }, { origin: { triggerId: sale.id } } as Ticket, () => fakeRpc().rpc)
    expect(tools.map(item => item.name)).toEqual(['odoo_search_read', 'odoo_message_post'])
    expect(tools[0]!.schema.safeParse({ model: 'sale.order' }).success).toBe(true)
    expect(tools[0]!.schema.safeParse({ model: 'mrp.production' }).success).toBe(false)
  })
})

describe('production progress', () => {
  const now = new Date('2026-11-04T00:00:00.000Z')

  it('keeps a closed or current order on track and asks with three options otherwise', () => {
    expect(classifyProduction('mrp.production', { name: 'WH/MO/1', state: 'done', date_deadline: '2026-11-01' }, now)).toEqual({ signal: 'on_track' })
    expect(classifyProduction('mrp.production', { name: 'WH/MO/1', state: 'progress', date_deadline: '2026-11-04', write_date: '2026-11-03 12:00:00' }, now).signal).toBe('on_track')
    const stale = classifyProduction('mrp.production', { name: 'WH/MO/1', state: 'progress', date_deadline: '2026-11-10', write_date: '2026-11-01 00:00:00' }, now)
    expect(stale.recommendation).toBe('chase')
    expect(stale.attention).toContain('Recommendation: 继续催.')
    const late = classifyProduction('mrp.production', { name: 'WH/MO/1', state: 'progress', date_deadline: '2026-11-03', product_qty: 10, qty_produced: 10 }, now)
    expect(late).toMatchObject({ signal: 'overdue', recommendation: 'reschedule' })
    const short = classifyProduction('mrp.production', { name: 'WH/MO/1', state: 'progress', date_deadline: '2026-11-03', product_qty: 10, qty_produced: 3, product_id: [4, 'Cabinet'] }, now)
    expect(short.recommendation).toBe('shortage')
    expect(short.attention).toContain('继续催')
    expect(short.attention).toContain('建议改期给人确认')
    expect(short.attention).toContain('升级缺料异常')
    expect(short.attention).toContain('Recommended.')
    expect(short.attention).toContain('does not send a customer email')
    expect(short.attention!.length).toBeLessThanOrEqual(1000)
    expect(classifyProduction('sale.order', { name: 'S0001', state: 'sale', commitment_date: '2026-11-01 00:00:00', product_qty: 10, qty_produced: 1 }, now).signal).toBe('overdue')
    expect(classifyProduction('sale.order', { name: 'S0001', state: 'cancel', commitment_date: '2020-01-01' }, now).signal).toBe('on_track')
    expect(classifyProduction('mrp.production', { state: 'progress', write_date: '2026-11-03 12:00:00' }, now).signal).toBe('on_track')
    const long = classifyProduction('mrp.production', {
      name: 'WH/MO/1', state: 'progress', date_deadline: '2020-01-01', product_id: [1, 'P'.repeat(500)], product_qty: 2, qty_produced: 0,
    }, now)
    expect(long.attention).toContain('1. 继续催')
    expect(long.attention).toContain('3. 升级缺料异常')
    expect(long.attention!.length).toBeLessThanOrEqual(1000)
  })

  it('reports a missing optional model and still describes a lead poll', async () => {
    const { rpc } = fakeRpc()
    rpc.fieldsGet = async model => {
      if (model === 'mrp.production') throw new OdooFault(1, "Object mrp.production doesn't exist")
      return { id: { type: 'integer' } }
    }
    expect(await optionalModelStatus(rpc)).toEqual(['mrp.production'])
    expect(pollHealthDetail({ primed: true, read: 0, unreadable: 0, afterId: 4 }, ['mrp.production']))
      .toBe('cursor at 4; waiting for new activities on crm.lead, mrp.production and sale.order; mrp.production not installed; crm.lead activities still poll')
    rpc.fieldsGet = async () => { throw new Error('connection reset') }
    await expect(optionalModelStatus(rpc)).rejects.toThrow('connection reset')
    expect(modelUnavailable(new OdooFault(1, 'Record does not exist or has been deleted.'))).toBe(false)
    expect(odooRecordGone(new OdooFault(1, "Object mrp.production doesn't exist"))).toBe(false)
  })
})

describe('odoo xml-rpc', () => {
  it('encodes a call and decodes the values Odoo returns, including a fault', () => {
    const domain = activityDomain(10, AGENT)
    expect(encodeCall('execute_kw', ['db', 3, 'a&b', domain])).toContain('<string>a&amp;b</string>')
    const decoded = decodeResponse(`<methodResponse><params><param><value>${encodeValue({ id: 4, name: 'Ada', ok: false, empty: null })}</value></param></params></methodResponse>`)
    expect(decoded).toEqual({ id: 4, name: 'Ada', ok: false, empty: null })
    expect(decodeResponse('<methodResponse><params><param><value><array><data><value><int>15</int></value></data></array></value></param></params></methodResponse>')).toEqual([15])
    expect(() => decodeResponse('<methodResponse><fault><value><struct><member><name>faultCode</name><value><int>1</int></value></member><member><name>faultString</name><value><string>MissingError</string></value></member></struct></value></fault></methodResponse>')).toThrow(OdooFault)
  })

  it('authenticates once per client and calls execute_kw with the session', async () => {
    const calls: { method: string; params: readonly unknown[] }[] = []
    const transport: XmlRpcTransport = { async call(_path, method, params) {
      calls.push({ method, params })
      return method === 'authenticate' ? 3 : [{ id: 15, phone: '555' }]
    } }
    const client = new OdooClient(transport, { url: 'http://127.0.0.1:8069', db: 'odoo', user: 'agent', password: 'secret' })
    expect(await client.searchRead('crm.lead', [['id', '=', 15]], { fields: ['phone'], limit: 1 })).toEqual([{ id: 15, phone: '555' }])
    const posted: { method: string; params: readonly unknown[] }[] = []
    transport.call = async (_path, method, params) => { posted.push({ method, params }); return method === 'authenticate' ? 3 : [90] }
    expect(await client.messagePost('crm.lead', 15, '<p>Noted</p>')).toBe(90)
    expect(posted[0]?.params[6]).toMatchObject({ body: '<p>Noted</p>', body_is_html: true, subtype_xmlid: 'mail.mt_note' })
    await client.uid()
    expect(calls.map(call => call.method)).toEqual(['authenticate', 'execute_kw'])
    expect(calls[1]!.params).toEqual(['odoo', 3, 'secret', 'crm.lead', 'search_read', [[['id', '=', 15]]], { fields: ['phone'], limit: 1 }])
    await expect(new OdooClient({ async call() { return false } }, { url: 'http://odoo', db: 'odoo', user: 'agent', password: 'secret' }).uid()).rejects.toThrow('authentication failed')
  })
})

describe('odoo plugin', () => {
  it('registers the kind and pauses until setup, then unregisters', async () => {
    const h = host()
    h.deps.configured = () => false
    const sources = new SourceRegistry(() => h.store.settings(), new HealthBoard())
    const disposers: (() => unknown)[] = []
    const value = { ...h.deps, sources, context: (kind: { kind: string; health: readonly string[] }) => sourceContextOf({ ...h.deps, sources }, kind) }
    applyOdoo({ orchestrator: value, effect: (effect: () => () => unknown) => { disposers.push(effect()) } } as never)
    expect(sources.kind('odoo')).toBe(odooKind)
    await vi.waitFor(() => expect(sources.healthEntries(['odoo']).get('odoo')?.get()).toMatchObject({ state: 'paused', code: 'setupPending' }))
    for (const dispose of disposers) await dispose()
    expect(sources.kind('odoo')).toBeUndefined()
    h.close()
  })
})
