/** Odoo source kind: poll `mail.activity` on `crm.lead` and post notes back on the lead. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { threadKey } from '../core/index.ts'
import { KV } from '../kv.ts'
import { health, sourceContext, type SourceContext } from './host.ts'
import type { SourceKind } from './kind.ts'
import { odooLink, sendOdoo } from './odoo-channel.ts'
import { odooThreadContext } from './odoo-read.ts'
import { ODOO_CREDENTIALS, odooEnv, odooRpc, type OdooRpc } from './odoo-rpc.ts'
import { ActivitySchema, ODOO_MODEL, SOURCE, activityDomain, leadThreadId, odooTrigger } from './odoo-trigger.ts'
import { pause } from './poll.ts'

const PAGE = 40
const ACTIVITY_FIELDS = ['id', 'res_model', 'res_id', 'summary', 'note', 'user_id', 'create_uid', 'create_date'] as const

const OdooConfigSchema = z.object({
  pollSeconds: z.number().int().min(10).max(3600).default(30),
  failuresBeforeError: z.number().int().min(1).max(20).default(3),
}).strict()
export type OdooConfig = z.infer<typeof OdooConfigSchema>

export const odooKind: SourceKind<OdooConfig> = {
  kind: SOURCE,
  title: { zh: 'Odoo', en: 'Odoo' },
  description: {
    zh: '轮询指派给智能体的 Odoo 用户、且挂在 crm.lead 上的新活动。连接使用环境变量 ODOO_URL、ODOO_DB、ODOO_USER、ODOO_PASSWORD，不写进设置。',
    en: 'Polls new activities on crm.lead assigned to the agent\'s Odoo user. The connection is ODOO_URL, ODOO_DB, ODOO_USER and ODOO_PASSWORD, which are not stored in settings.',
  },
  schema: OdooConfigSchema,
  fields: [
    { key: 'pollSeconds', type: 'number', advanced: true, min: 10, max: 3600, label: { zh: '轮询间隔 / 秒', en: 'Polling interval / seconds' },
      hint: { zh: '第一次轮询只记下当前最大活动编号，不接收以前的活动。', en: 'The first poll records the current highest activity id and does not receive earlier activities.' } },
    { key: 'failuresBeforeError', type: 'number', advanced: true, min: 1, max: 20, label: { zh: '连续失败几次后报告异常', en: 'Failed polls before reporting an error' },
      hint: { zh: '单次网络中断会在下一次轮询时自动重试，不必报告。', en: 'A single network interruption is retried on the next poll and need not be reported.' } },
  ],
  health: ['odoo'],
  scope({ meta }) {
    return meta.model === ODOO_MODEL ? { listened: true, observed: false, row: ODOO_MODEL } : { listened: false, reason: 'model_not_allowed' }
  },
  channel: {
    allowed: address => address.model === ODOO_MODEL && /^[1-9]\d*$/.test(address.res_id ?? ''),
    send: sendOdoo,
    link: odooLink,
  },
  threadContext: odooThreadContext,
  find: query => {
    const id = /(?:crm\.lead[/:]|model=crm\.lead&id=)(\d+)/i.exec(query)?.[1]
    return { threads: id ? [`${SOURCE}:${leadThreadId(Number(id))}`] : [], terms: [] }
  },
  policy: {
    schema: z.object({
      allowed: z.array(z.object({
        id: z.string().regex(/^[1-9]\d*$/),
        name: z.string().trim().max(100).optional(),
      }).strict()).default([]),
    }).strict(),
    fields: [{ key: 'allowed', type: 'rows', label: { zh: '能发起工作的 Odoo 用户', en: 'Odoo users who may originate work' },
      columns: [
        { key: 'id', type: 'text', label: { zh: '用户 id', en: 'User id' }, pattern: '[1-9][0-9]*' },
        { key: 'name', type: 'text', label: { zh: '名字', en: 'Name' }, optional: true },
      ] }],
    explicit: { zh: '名单里的用户把 crm.lead 上的活动指派给智能体的 Odoo 用户。', en: 'A user on the list assigns an activity on a crm.lead to the agent\'s Odoo user.' },
    rows: () => [{ id: ODOO_MODEL, label: { zh: 'CRM 线索', en: 'CRM leads' }, note: { zh: '仅指派给智能体的活动', en: 'Activities assigned to the agent' },
      cells: { listedUnaddressed: false, unlistedAddressed: true, unlistedUnaddressed: false } }],
  },
  environment: {
    variables: [
      { key: 'DSH_SUPERAGENT_ODOO_MODEL', description: { zh: '接下工单的 Odoo 模型；不是从这个来源来的时为空', en: 'Odoo model that started the ticket; empty when the ticket did not start on Odoo' } },
      { key: 'DSH_SUPERAGENT_ODOO_RES_ID', description: { zh: '接下工单的记录 id；不是从这个来源来的时为空', en: 'Record id that started the ticket; empty when the ticket did not start on Odoo' } },
      { key: 'DSH_SUPERAGENT_ODOO_ACTIVITY', description: { zh: '接下工单的 mail.activity id；不是从这个来源来的时为空', en: 'mail.activity id that started the ticket; empty when the ticket did not start on Odoo' } },
    ],
    values: ({ trigger }) => {
      const odoo = trigger?.source === SOURCE
      return {
        DSH_SUPERAGENT_ODOO_MODEL: odoo ? String(trigger.meta.model ?? '') : '',
        DSH_SUPERAGENT_ODOO_RES_ID: odoo ? String(trigger.meta.resId ?? '') : '',
        DSH_SUPERAGENT_ODOO_ACTIVITY: odoo ? String(trigger.meta.activityId ?? '') : '',
      }
    },
  },
}

export const name = 'dsh-superagent-odoo'
export const inject = ['orchestrator']
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.orchestrator.sources.register(odooKind), 'odoo: source kind')
  ctx.effect(() => {
    const source = sourceContext(ctx.orchestrator, odooKind)
    const controller = new AbortController()
    const running = watch(source, controller.signal)
      .catch((error: unknown) => { source.report('odoo', { state: 'error', detail: String(error) }) })
    return async () => { controller.abort(); await running }
  })
}

/** Read activities after the cursor. The first call records the current maximum and emits nothing. */
export async function pollActivities(ctx: SourceContext, rpc: OdooRpc, signal: AbortSignal): Promise<{ read: number; unreadable: number; primed: boolean; afterId: number }> {
  const base = odooEnv()?.url ?? ''
  const stored = ctx.state.get(KV.odoo.activity)
  const agentUid = await rpc.uid(signal)
  if (!stored) {
    const newest = await rpc.searchRead('mail.activity', [], { fields: ['id'], limit: 1, order: 'id desc' }, signal)
    const afterId = typeof newest[0]?.id === 'number' ? newest[0].id : 0
    ctx.state.set(KV.odoo.activity, { afterId })
    return { read: 0, unreadable: 0, primed: true, afterId }
  }
  let afterId = stored.afterId
  let read = 0
  let unreadable = 0
  for (let page = 0; page < 10; page++) {
    if (signal.aborted) throw new Error('The Odoo Source stopped during the read')
    const rows = await rpc.searchRead('mail.activity', activityDomain(afterId, agentUid), { fields: ACTIVITY_FIELDS, limit: PAGE, order: 'id asc' }, signal)
    read += rows.length
    for (const row of rows) {
      if (signal.aborted) throw new Error('The Odoo Source stopped during the read')
      const id = typeof row.id === 'number' ? row.id : undefined
      if (id === undefined) throw new Error('Odoo returned a mail.activity without an id')
      const parsed = ActivitySchema.safeParse(row)
      if (!parsed.success) { unreadable += 1; afterId = id; ctx.state.set(KV.odoo.activity, { afterId }); continue }
      const trigger = odooTrigger(parsed.data, agentUid, base)
      if (trigger) {
        await ctx.receive(trigger)
        const lead = String(parsed.data.res_id)
        ctx.threads.describe(threadKey(trigger.threads[0]!), {
          label: `Lead ${lead}`,
          ...(trigger.url ? { url: trigger.url } : {}),
          facts: { lead: { label: { zh: '线索', en: 'Lead' }, value: lead }, activity: { value: String(parsed.data.id) } },
        })
      }
      afterId = id
      ctx.state.set(KV.odoo.activity, { afterId })
    }
    if (rows.length < PAGE) break
  }
  return { read, unreadable, primed: false, afterId }
}

async function watch(ctx: SourceContext, signal: AbortSignal): Promise<void> {
  let failures = 0
  await ctx.ready
  if (!ctx.configured()) { ctx.report('odoo', health('paused', 'setupPending')); return }
  while (!signal.aborted) {
    const config = ctx.config<OdooConfig>(SOURCE)
    try {
      if (!config) ctx.report('odoo', health('paused', 'sourceOff'))
      else if (!odooEnv()) ctx.report('odoo', { state: 'error', detail: ODOO_CREDENTIALS })
      else {
        const round = await pollActivities(ctx, odooRpc(), signal)
        failures = 0
        const detail = round.primed ? `cursor at ${round.afterId}; waiting for new crm.lead activities`
          : `${round.read} activities, ${round.unreadable} unreadable`
        ctx.report('odoo', { state: 'ready', detail, at: new Date().toISOString() })
      }
    } catch (error) {
      failures += 1
      if (!signal.aborted && failures >= (config?.failuresBeforeError ?? 3)) {
        ctx.report('odoo', health('error', 'pollFailures', { count: String(failures), error: String(error) }))
      }
    }
    await pause((config?.pollSeconds ?? 30) * 1000, signal)
  }
}
