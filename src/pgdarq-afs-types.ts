export type PgdarqAFSEncryptionCipher =
  | 'aes128gcm'
  | 'aes256gcm'
  | 'aegis256'
  | 'aegis256x2'
  | 'aegis128l'
  | 'aegis128x2'
  | 'aegis128x4'

export interface PgdarqAFSEncryptionOptions {
  cipher: PgdarqAFSEncryptionCipher
  hexkey: string
}

export interface PgdarqAFSOptions {
  brokerPort?: MessagePort
  brokerWorker?: Worker
  bootstrapMemoryThresholdBytes?: number
  chunkSize?: number
  databaseName?: string
  debug?: boolean
  encryption?: PgdarqAFSEncryptionOptions
  relaxedDurability?: boolean
}

export interface PgdarqAFSBrokerOptions {
  chunkSize?: number
  databaseName: string
  debug?: boolean
  encryption?: PgdarqAFSEncryptionOptions
  persistentPath?: string
}
