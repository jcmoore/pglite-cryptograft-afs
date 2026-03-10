export { EncryptedFS, type EncryptedFSOptions } from './encrypted-fs.js'
export { PgdarqAFS } from './pgdarq-afs.js'
export type {
  PgdarqAFSBrokerOptions,
  PgdarqAFSOptions,
} from './pgdarq-afs-types.js'

export {
  PAGE_SIZE,
  SALT_SIZE,
  FILE_ID_SIZE,
  FILE_HEADER_SIZE,
  IV_SIZE,
  AUTH_TAG_SIZE,
  ENCRYPTED_PAGE_SIZE,
  KDF_ITERATIONS,
  VERIFICATION_MAGIC,
  VERIFICATION_FILE_ID,
  deriveKeys,
  randomSalt,
  encryptPage,
  decryptPage,
  fileIdFromPath,
  type DerivedKeys,
} from './crypto.js'
