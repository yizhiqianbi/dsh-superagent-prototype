/** Odoo XML-RPC session: authenticate, then `execute_kw` for the three calls V0 needs. Credentials stay in the environment. */
import { decodeResponse, encodeCall, OdooFault } from './odoo-xml.ts'

/** Where the Odoo client connects. The password is never written to settings, prompts or health. */
export interface OdooEnv {
  url: string
  db: string
  user: string
  password: string
}

/** XML-RPC transport. Tests substitute one; production posts to `ODOO_URL`. */
export interface XmlRpcTransport {
  call(path: '/xmlrpc/2/common' | '/xmlrpc/2/object', method: string, params: readonly unknown[], signal?: AbortSignal): Promise<unknown>
}

/** The calls the Source and the worker tools share. */
export interface OdooRpc {
  uid(signal?: AbortSignal): Promise<number>
  searchRead(model: string, domain: readonly unknown[], options: { fields: readonly string[]; limit?: number; order?: string }, signal?: AbortSignal): Promise<Record<string, unknown>[]>
  write(model: string, ids: readonly number[], values: Record<string, unknown>, signal?: AbortSignal): Promise<boolean>
  messagePost(model: string, id: number, body: string, signal?: AbortSignal): Promise<number>
}

const DEFAULT_URL = 'http://127.0.0.1:8069'

/** Read `ODOO_URL`, `ODOO_DB`, `ODOO_USER` and `ODOO_PASSWORD`. Undefined when the database, user or password is missing. */
export function odooEnv(env: NodeJS.ProcessEnv = process.env): OdooEnv | undefined {
  const url = (env.ODOO_URL?.trim() || DEFAULT_URL).replace(/\/$/, '')
  const db = env.ODOO_DB?.trim() ?? ''
  const user = env.ODOO_USER?.trim() ?? ''
  const password = env.ODOO_PASSWORD ?? ''
  if (!db || !user || !password) return undefined
  return { url, db, user, password }
}

/** The sentence health reports when the Source is on and the environment has no database, user or password. */
export const ODOO_CREDENTIALS = 'Set ODOO_DB, ODOO_USER and ODOO_PASSWORD (ODOO_URL defaults to http://127.0.0.1:8069)'

let transportOverride: XmlRpcTransport | undefined

/** Test seam. Production leaves the HTTP transport in place. */
export function setOdooTransport(transport: XmlRpcTransport | undefined): void {
  transportOverride = transport
}

/** The client for this process: the test transport when one is set, otherwise HTTP. */
export function odooRpc(env: NodeJS.ProcessEnv = process.env): OdooRpc {
  const credentials = odooEnv(env)
  if (!credentials) throw new Error(ODOO_CREDENTIALS)
  return new OdooClient(transportOverride ?? httpTransport(credentials), credentials)
}

function httpTransport(env: OdooEnv): XmlRpcTransport {
  return {
    async call(path, method, params, signal) {
      const response = await fetch(new URL(path, env.url), {
        method: 'POST',
        headers: { 'Content-Type': 'text/xml', Accept: 'text/xml' },
        body: encodeCall(method, params),
        signal,
      })
      const text = await response.text()
      if (!response.ok && !text.includes('<methodResponse')) throw new Error(`Odoo HTTP ${response.status} on ${path}`)
      return decodeResponse(text)
    },
  }
}

/** One authenticated XML-RPC session. `uid` is cached for the life of this client, which is one poll or one tool call. */
export class OdooClient implements OdooRpc {
  private userId: number | undefined
  constructor(private readonly transport: XmlRpcTransport, private readonly env: OdooEnv) {}

  async uid(signal?: AbortSignal): Promise<number> {
    if (this.userId !== undefined) return this.userId
    const id = await this.transport.call('/xmlrpc/2/common', 'authenticate', [this.env.db, this.env.user, this.env.password, {}], signal)
    if (typeof id !== 'number' || !Number.isInteger(id) || id <= 0) throw new Error('Odoo authentication failed')
    this.userId = id
    return id
  }

  async searchRead(model: string, domain: readonly unknown[], options: { fields: readonly string[]; limit?: number; order?: string }, signal?: AbortSignal): Promise<Record<string, unknown>[]> {
    const kwargs: Record<string, unknown> = { fields: [...options.fields] }
    if (options.limit !== undefined) kwargs.limit = options.limit
    if (options.order !== undefined) kwargs.order = options.order
    const rows = await this.execute(model, 'search_read', [domain], kwargs, signal)
    if (!Array.isArray(rows)) throw new Error(`Odoo search_read on ${model} returned no list`)
    return rows.filter((row): row is Record<string, unknown> => !!row && typeof row === 'object' && !Array.isArray(row))
  }

  async write(model: string, ids: readonly number[], values: Record<string, unknown>, signal?: AbortSignal): Promise<boolean> {
    const wrote = await this.execute(model, 'write', [ids, values], {}, signal)
    if (wrote !== true) throw new Error(`Odoo write on ${model} was refused`)
    return true
  }

  async messagePost(model: string, id: number, body: string, signal?: AbortSignal): Promise<number> {
    const posted = await this.execute(model, 'message_post', [[id]], { body, message_type: 'comment', subtype_xmlid: 'mail.mt_note' }, signal)
    // Odoo 20 returns the new message as a one-element list of ids. Earlier versions return the id.
    const messageId = typeof posted === 'number' ? posted : Array.isArray(posted) && typeof posted[0] === 'number' ? posted[0] : undefined
    if (messageId === undefined || !Number.isInteger(messageId)) throw new Error('Odoo message_post returned no message id')
    return messageId
  }

  private async execute(model: string, method: string, args: unknown[], kwargs: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
    const uid = await this.uid(signal)
    return this.transport.call('/xmlrpc/2/object', 'execute_kw',
      [this.env.db, uid, this.env.password, model, method, args, kwargs], signal)
  }
}

/** True when Odoo says the record can never be written again. Other faults are retried. */
export function odooRecordGone(error: unknown): boolean {
  return error instanceof OdooFault && /does not exist|has been deleted|MissingError/i.test(error.message)
}
