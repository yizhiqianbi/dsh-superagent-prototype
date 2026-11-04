/** Downloads a WeCom picture while its url is still valid and keeps the bytes for the session. */
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { z } from 'zod'
import type { Trigger } from '../core/index.ts'
import {
  WECOM_FILE_MISSED, WECOM_FILE_NOTE, WECOM_IMAGE_MAX, WECOM_IMAGE_MISSED, wecomFileMarker, wecomImageKeys, wecomImageMarker,
  type WecomPendingMedia,
} from './wecom-trigger.ts'

const MAX_BYTES = 8 * 1024 * 1024
const KEY = /^wximg_[1-9]\d*$/
const FILE = /^wecom-images\/[A-Za-z0-9._-]+$/
const PendingSchema = z.object({
  key: z.string().regex(KEY),
  url: z.string().min(1),
  aeskey: z.string().min(1).optional(),
  kind: z.enum(['image', 'file']),
}).strict()
const SavedSchema = z.object({
  key: z.string().regex(KEY),
  file: z.string().regex(FILE),
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']),
}).strict()
type SavedImage = z.infer<typeof SavedSchema>
export interface WecomTurnImage { data: Uint8Array; mediaType: ImageMediaType; name: string }
type Download = (url: string, aesKey?: string) => Promise<{ buffer: Uint8Array }>

const EXT: Record<ImageMediaType, string> = { 'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif' }

function startsWith(data: Uint8Array, bytes: readonly number[]): boolean {
  if (data.length < bytes.length) return false
  return bytes.every((byte, index) => data[index] === byte)
}
/** PNG, JPEG, WebP, or GIF. Anything else is not shown to the model as a picture. */
export function imageMediaType(data: Uint8Array): ImageMediaType | undefined {
  if (startsWith(data, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(data, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]) || startsWith(data, [0x47, 0x49, 0x46, 0x38, 0x37, 0x61])) return 'image/gif'
  if (startsWith(data, [0x52, 0x49, 0x46, 0x46]) && data.length >= 12
    && data[8] === 0x57 && data[9] === 0x45 && data[10] === 0x42 && data[11] === 0x50) return 'image/webp'
  return undefined
}
function replaceOnce(text: string, from: string, to: string): string {
  const at = text.indexOf(from)
  if (at < 0) return text
  return text.slice(0, at) + to + text.slice(at + from.length)
}
function withoutPending(meta: Record<string, unknown>): Record<string, unknown> {
  const next = { ...meta }
  delete next.pendingMedia
  return next
}
function pendingOf(trigger: Trigger): WecomPendingMedia[] {
  const parsed = z.array(PendingSchema).safeParse(trigger.meta.pendingMedia)
  return parsed.success ? parsed.data : []
}
function missed(kind: WecomPendingMedia['kind']): string {
  switch (kind) {
    case 'image': return WECOM_IMAGE_MISSED
    case 'file': return WECOM_FILE_MISSED
    default: {
      const unreachable: never = kind
      return unreachable
    }
  }
}
function marker(item: WecomPendingMedia): string {
  switch (item.kind) {
    case 'image': return wecomImageMarker(item.key)
    case 'file': return wecomFileMarker(item.key)
    default: {
      const unreachable: never = item.kind
      return unreachable
    }
  }
}
async function writeSaved(root: string, triggerId: string, imageKey: string, mediaType: ImageMediaType, data: Uint8Array): Promise<string> {
  if (!/^[a-f0-9]{32}$/.test(triggerId) || !KEY.test(imageKey)) throw new Error('Refusing to store a WeCom image under an unexpected name')
  const dir = join(root, 'wecom-images')
  await mkdir(dir, { recursive: true })
  const path = join(dir, `${triggerId}-${imageKey}${EXT[mediaType]}`)
  await writeFile(path, data)
  const resolved = await realpath(path)
  const prefix = root.endsWith(sep) ? root : root + sep
  const rel = relative(root, resolved).split(sep).join('/')
  if (!resolved.startsWith(prefix) || !FILE.test(rel)) {
    await rm(path, { force: true })
    throw new Error('WeCom image path left the state directory')
  }
  return rel
}

/**
 * Downloads each pending picture, decrypts it with the frame's aes key, and stores it under `stateDir`.
 * The stored trigger keeps a relative path. The url and aes key are dropped, including when a download fails.
 */
export async function materializeWecomImages(trigger: Trigger, download: Download, stateDir: string, maxBytes = MAX_BYTES): Promise<Trigger> {
  const pending = pendingOf(trigger)
  if (!pending.length && !('pendingMedia' in trigger.meta)) return trigger
  let root: string | undefined
  try { root = await realpath(stateDir) } catch { root = undefined }
  let text = trigger.text
  const saved: SavedImage[] = []
  for (const item of pending) {
    const token = marker(item)
    if (!root || !/^https:\/\//i.test(item.url)) { text = replaceOnce(text, token, missed(item.kind)); continue }
    try {
      const { buffer } = await download(item.url, item.aeskey)
      const bytes = new Uint8Array(buffer)
      const mediaType = imageMediaType(bytes)
      if (!mediaType) { text = replaceOnce(text, token, item.kind === 'file' ? WECOM_FILE_NOTE : WECOM_IMAGE_MISSED); continue }
      if (bytes.byteLength === 0 || bytes.byteLength > maxBytes) { text = replaceOnce(text, token, missed(item.kind)); continue }
      const file = await writeSaved(root, trigger.id, item.key, mediaType, bytes)
      saved.push({ key: item.key, file, mediaType })
      if (item.kind === 'file') text = replaceOnce(text, token, wecomImageMarker(item.key))
    } catch {
      text = replaceOnce(text, token, missed(item.kind))
    }
  }
  const meta = withoutPending(trigger.meta)
  if (saved.length) meta.images = saved
  return { ...trigger, text: text.trim() || WECOM_IMAGE_MISSED, meta }
}

async function readSaved(stateDir: string, image: SavedImage): Promise<Uint8Array | undefined> {
  const root = await realpath(stateDir)
  const parts = image.file.split('/')
  if (parts.some(part => part === '' || part === '.' || part === '..')) return undefined
  const path = join(root, ...parts)
  const resolved = await realpath(path)
  const prefix = root.endsWith(sep) ? root : root + sep
  if (!resolved.startsWith(prefix)) return undefined
  const file = await stat(resolved)
  if (!file.isFile() || file.size === 0 || file.size > MAX_BYTES) return undefined
  const data = new Uint8Array(await readFile(resolved))
  return imageMediaType(data) === image.mediaType ? data : undefined
}
function savedImages(trigger: Trigger): SavedImage[] {
  const parsed = z.array(SavedSchema).safeParse(trigger.meta.images)
  return parsed.success ? parsed.data.slice(0, WECOM_IMAGE_MAX) : []
}

/** Bytes of pictures already stored for these triggers, newest trigger first. A missing file is skipped. */
export async function loadWecomTurnImages(triggers: readonly Trigger[], stateDir: string): Promise<WecomTurnImage[]> {
  const wanted = [...triggers].reverse().flatMap(trigger => trigger.source === 'wecom'
    ? savedImages(trigger).filter(image => wecomImageKeys(trigger.text).includes(image.key)).map(image => ({ image }))
    : [])
  if (!wanted.length) return []
  const images: WecomTurnImage[] = []
  for (const { image } of wanted) {
    if (images.length >= WECOM_IMAGE_MAX) break
    try {
      const data = await readSaved(stateDir, image)
      if (!data) continue
      images.push({ data, mediaType: image.mediaType, name: `${image.key}${EXT[image.mediaType]}` })
    } catch { /* The turn still arrives with its text. */ }
  }
  return images
}

/** Reads one stored WeCom picture the way a Feishu image is read during assessment. The url has already expired. */
export async function readWecomImage(agent: Agent, trigger: Trigger, message: { id: string; text: string }, imageKey: string,
  stateDir: string, signal: AbortSignal): Promise<{ source_message_id: string; image_key: string; image: unknown }> {
  if (!wecomImageKeys(message.text).includes(imageKey)) throw new Error('Choose an image key from this source message')
  const messageId = typeof trigger.meta.messageId === 'string' ? trigger.meta.messageId : ''
  if (!messageId || message.id !== messageId) throw new Error('Choose an image key from this source message')
  const attachments = agent.ctx.get('attachments')
  if (!attachments) throw new Error('Image reading is unavailable: no attachment service is mounted')
  const route = agent.session.requestHeader()?.config
  const provider = route?.provider ?? agent.options.provider
  const model = route?.model ?? agent.options.model
  const llm = agent.ctx.get('llm')
  if (!llm || !provider || !model) throw new Error('Image reading is unavailable: the current model route is unresolved')
  const info = await llm.resolveModelInfo(provider, model, signal)
  if (!info.inputModalities?.includes('image')) throw new Error(`Model ${model} does not support image input; the image has not been inspected`)
  signal.throwIfAborted()
  const image = savedImages(trigger).find(item => item.key === imageKey)
  const data = image ? await readSaved(stateDir, image) : undefined
  if (!image || !data) throw new Error('The image is no longer available')
  if (data.byteLength > Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes)) throw new Error('The image exceeds the deployment byte limit or is not a regular file')
  signal.throwIfAborted()
  const saved = await attachments.saveImage({ data, mediaType: image.mediaType, name: `${imageKey}${EXT[image.mediaType]}` })
  signal.throwIfAborted()
  return { source_message_id: messageId, image_key: imageKey, image: saved }
}
