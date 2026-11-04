/** One WeCom long connection per BotID. The SDK keeps the socket, the heartbeat and the reconnects. */
import { WSAuthFailureError, WSClient, WSReconnectExhaustedError, type Logger, type SendMsgBody } from '@wecom/aibot-node-sdk'
import type { WecomOutbound } from './wecom-channel.ts'

export const WECOM_WS_URL = 'wss://openws.work.weixin.qq.com'
export type WecomSocketEvent = 'authenticated' | 'disconnected' | 'reconnecting' | 'error' | 'message.text' | 'message.voice'
  | 'message.image' | 'message.file' | 'message.mixed' | 'event.template_card_event' | 'event.disconnected_event'
export interface WecomSocket {
  connect(): void
  disconnect(): void
  sendMessage(chatId: string, body: WecomOutbound): Promise<unknown>
  /** Downloads and decrypts one media url. `aesKey` is the frame's `aeskey`. */
  downloadFile(url: string, aesKey?: string): Promise<{ buffer: Uint8Array; filename?: string }>
  on(event: WecomSocketEvent, handler: (payload: unknown) => void): void
}
export interface WecomCredentials { botId: string; secret: string }
type SocketFactory = (credentials: WecomCredentials) => WecomSocket
type WecomSend = (chatId: string, body: WecomOutbound) => Promise<unknown>

const quiet: Logger = { debug() {}, info() {}, warn() {}, error() {} }
const openBots = new Set<string>()
let factory: SocketFactory = sdkSocket
let sendImpl: WecomSend | undefined

function sdkSocket(credentials: WecomCredentials): WecomSocket {
  const client = new WSClient({
    botId: credentials.botId, secret: credentials.secret, wsUrl: WECOM_WS_URL,
    heartbeatInterval: 30_000, maxReconnectAttempts: -1, logger: quiet,
  })
  return {
    connect: () => { client.connect() },
    disconnect: () => { client.disconnect() },
    sendMessage: (chatId, body) => client.sendMessage(chatId, body as SendMsgBody),
    downloadFile: (url, aesKey) => client.downloadFile(url, aesKey),
    on: (event, handler) => { client.on(event, handler as never) },
  }
}

/** Replaces the SDK client. Tests pass a fake; omitting the argument restores the SDK. */
export function setWecomSocketFactory(next?: SocketFactory): void {
  factory = next ?? sdkSocket
}
/** The open socket's sender, set only after authentication. */
export const currentWecomSend = (): WecomSend | undefined => sendImpl
/** Installs `send` until the returned function runs, and only if it is still current. */
export function bindWecomSend(send: WecomSend): () => void {
  sendImpl = send
  return () => { if (sendImpl === send) sendImpl = undefined }
}
/**
 * Refuses a second socket for the same BotID in this process. WeCom keeps one subscription: a new one disconnects the old.
 * The returned function releases the claim.
 */
export function acquireWecomBot(botId: string): () => void {
  if (openBots.has(botId)) throw new Error(`A WeCom long connection for ${botId} is already open`)
  openBots.add(botId)
  return () => { openBots.delete(botId) }
}
export function createWecomSocket(credentials: WecomCredentials): WecomSocket {
  return factory(credentials)
}
/** Drops a test factory, a stuck sender and any leaked BotID claim. */
export function resetWecomRuntime(): void {
  factory = sdkSocket
  sendImpl = undefined
  openBots.clear()
}
export const wecomAuthFailed = (error: unknown): boolean => error instanceof WSAuthFailureError || error instanceof WSReconnectExhaustedError
