import { describe, expect, it } from 'vitest'
import {
  createSyncChannel,
  decodeSyncRequest,
  decodeSyncResponse,
  encodeSyncError,
  encodeSyncRequest,
  encodeSyncResponse,
} from '../../src/pgdarq-afs-rpc.js'

describe('pgdarq-afs rpc helpers', () => {
  it('round-trips sync read requests and responses', () => {
    const channel = createSyncChannel()
    encodeSyncRequest(channel, {
      kind: 'readChunk',
      ino: 12,
      chunkIndex: 4,
    })

    expect(decodeSyncRequest(channel)).toEqual({
      kind: 'readChunk',
      ino: 12,
      chunkIndex: 4,
    })

    encodeSyncResponse(channel, {
      kind: 'readChunk',
      found: true,
      payload: {
        meta: new Uint8Array([9]),
        data: new Uint8Array([1, 2, 3]),
      },
    })

    const response = decodeSyncResponse(channel)
    expect(response.kind).toBe('readChunk')
    expect(response.found).toBe(true)
    expect(response.payload?.meta).toEqual(new Uint8Array([9]))
    expect(response.payload?.data).toEqual(new Uint8Array([1, 2, 3]))
  })

  it('surfaces sync rpc errors', () => {
    const channel = createSyncChannel()
    encodeSyncError(channel, new Error('boom'))
    expect(() => decodeSyncResponse(channel)).toThrow(/boom/)
  })
})
