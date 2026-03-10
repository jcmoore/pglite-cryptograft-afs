import type { PgdarqAfsChunkPayload, PgdarqAfsFlushBatch, PgdarqAfsSnapshot } from './pgdarq-afs-schema.js'

export const PGDARQ_SYNC_STATE_IDLE = 0
export const PGDARQ_SYNC_STATE_DONE = 1
export const PGDARQ_SYNC_STATE_ERROR = 2

const TEXT_ENCODER = new TextEncoder()
const TEXT_DECODER = new TextDecoder()

export interface PgdarqAfsSyncChannel {
  control: SharedArrayBuffer
  request: SharedArrayBuffer
  response: SharedArrayBuffer
}

export interface PgdarqAfsSyncReadChunkRequest {
  kind: 'readChunk'
  ino: number
  chunkIndex: number
}

export interface PgdarqAfsSyncReadChunkResponse {
  kind: 'readChunk'
  found: boolean
  payload: PgdarqAfsChunkPayload | null
}

export type PgdarqAfsSyncRequest = PgdarqAfsSyncReadChunkRequest
export type PgdarqAfsSyncResponse = PgdarqAfsSyncReadChunkResponse

export interface PgdarqAfsBrokerInitMessage {
  type: 'pgdarq-afs:init'
  channel: PgdarqAfsSyncChannel
  options: unknown
}

export interface PgdarqAfsBrokerSyncMessage {
  type: 'pgdarq-afs:sync'
}

export interface PgdarqAfsBrokerRequestMessage {
  id: number
  payload:
    | { type: 'snapshot' }
    | { type: 'flush'; batch: PgdarqAfsFlushBatch; strict: boolean }
    | { type: 'close' }
}

export interface PgdarqAfsBrokerResponseMessage {
  id: number
  ok: boolean
  payload?: PgdarqAfsSnapshot | { strictCompleted: boolean } | { closed: true }
  error?: { message: string }
}

export function createSyncChannel(
  requestBytes = 1024,
  responseBytes = 32 * 1024,
): PgdarqAfsSyncChannel {
  return {
    control: new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT * 4),
    request: new SharedArrayBuffer(requestBytes),
    response: new SharedArrayBuffer(responseBytes),
  }
}

export function encodeSyncRequest(
  channel: PgdarqAfsSyncChannel,
  request: PgdarqAfsSyncRequest,
): void {
  const control = new Int32Array(channel.control)
  const buffer = new Uint8Array(channel.request)
  const bytes = TEXT_ENCODER.encode(JSON.stringify(request))
  if (bytes.length > buffer.byteLength) {
    throw new Error(
      `Sync request buffer too small: ${bytes.length} > ${buffer.byteLength}`,
    )
  }
  buffer.fill(0)
  buffer.set(bytes)
  Atomics.store(control, 0, PGDARQ_SYNC_STATE_IDLE)
  Atomics.store(control, 1, bytes.length)
  Atomics.store(control, 2, 0)
}

export function decodeSyncRequest(channel: PgdarqAfsSyncChannel): PgdarqAfsSyncRequest {
  const control = new Int32Array(channel.control)
  const buffer = new Uint8Array(channel.request)
  const length = Atomics.load(control, 1)
  const text = TEXT_DECODER.decode(copySharedBytes(buffer, length))
  return JSON.parse(text) as PgdarqAfsSyncRequest
}

export function encodeSyncResponse(
  channel: PgdarqAfsSyncChannel,
  response: PgdarqAfsSyncResponse,
): void {
  const control = new Int32Array(channel.control)
  const buffer = new Uint8Array(channel.response)
  const bytes = TEXT_ENCODER.encode(JSON.stringify(serializeSyncResponse(response)))
  if (bytes.length > buffer.byteLength) {
    throw new Error(
      `Sync response buffer too small: ${bytes.length} > ${buffer.byteLength}`,
    )
  }
  buffer.fill(0)
  buffer.set(bytes)
  Atomics.store(control, 2, bytes.length)
  Atomics.store(control, 0, PGDARQ_SYNC_STATE_DONE)
  Atomics.notify(control, 0, 1)
}

export function encodeSyncError(
  channel: PgdarqAfsSyncChannel,
  error: unknown,
): void {
  const control = new Int32Array(channel.control)
  const buffer = new Uint8Array(channel.response)
  const payload = { error: error instanceof Error ? error.message : String(error) }
  const bytes = TEXT_ENCODER.encode(JSON.stringify(payload))
  if (bytes.length > buffer.byteLength) {
    throw new Error(
      `Sync response buffer too small: ${bytes.length} > ${buffer.byteLength}`,
    )
  }
  buffer.fill(0)
  buffer.set(bytes)
  Atomics.store(control, 2, bytes.length)
  Atomics.store(control, 0, PGDARQ_SYNC_STATE_ERROR)
  Atomics.notify(control, 0, 1)
}

export function decodeSyncResponse(channel: PgdarqAfsSyncChannel): PgdarqAfsSyncResponse {
  const control = new Int32Array(channel.control)
  const buffer = new Uint8Array(channel.response)
  const state = Atomics.load(control, 0)
  const length = Atomics.load(control, 2)
  const text = TEXT_DECODER.decode(copySharedBytes(buffer, length))
  const decoded = JSON.parse(text) as
    | { error: string }
    | ReturnType<typeof serializeSyncResponse>

  if (state === PGDARQ_SYNC_STATE_ERROR) {
    throw new Error('error' in decoded ? decoded.error : 'Unknown sync RPC error')
  }

  if (state !== PGDARQ_SYNC_STATE_DONE) {
    throw new Error(`Sync RPC completed with unexpected state: ${state}`)
  }

  return deserializeSyncResponse(decoded as ReturnType<typeof serializeSyncResponse>)
}

function copySharedBytes(buffer: Uint8Array, length: number): Uint8Array {
  const copy = new Uint8Array(length)
  copy.set(buffer.subarray(0, length))
  return copy
}

function serializeSyncResponse(response: PgdarqAfsSyncResponse): {
  kind: 'readChunk'
  found: boolean
  meta: string | null
  data: string | null
} {
  return {
    kind: response.kind,
    found: response.found,
    meta: response.payload?.meta ? bytesToBase64(response.payload.meta) : null,
    data: response.payload?.data ? bytesToBase64(response.payload.data) : null,
  }
}

function deserializeSyncResponse(payload: {
  kind: 'readChunk'
  found: boolean
  meta: string | null
  data: string | null
}): PgdarqAfsSyncResponse {
  return {
    kind: payload.kind,
    found: payload.found,
    payload:
      payload.found && payload.data
        ? {
            meta: payload.meta ? base64ToBytes(payload.meta) : null,
            data: base64ToBytes(payload.data),
          }
        : null,
  }
}

export function bytesToBase64(value: Uint8Array): string {
  let binary = ''
  for (const byte of value) {
    binary += String.fromCharCode(byte)
  }
  return btoa(binary)
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}
