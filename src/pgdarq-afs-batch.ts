import {
  createEmptyFlushBatch,
  type PgdarqAfsChunkPayload,
  type PgdarqAfsChunkRecord,
  type PgdarqAfsDentryDelete,
  type PgdarqAfsDentryRecord,
  type PgdarqAfsFlushBatch,
  type PgdarqAfsInodeRecord,
} from './pgdarq-afs-schema.js'

export class PgdarqAfsBatchBuilder {
  private readonly createdTables = new Set<number>()
  private readonly deletedInodes = new Set<number>()
  private readonly deletedChunks = new Map<string, { ino: number; chunkIndex: number }>()
  private readonly deletedDentries = new Map<string, PgdarqAfsDentryDelete>()
  private readonly upsertInodes = new Map<number, PgdarqAfsInodeRecord>()
  private readonly upsertDentries = new Map<string, PgdarqAfsDentryRecord>()
  private readonly upsertChunks = new Map<string, PgdarqAfsChunkRecord>()

  markTableCreated(ino: number): void {
    this.createdTables.add(ino)
  }

  upsertInode(inode: PgdarqAfsInodeRecord): void {
    this.deletedInodes.delete(inode.ino)
    this.upsertInodes.set(inode.ino, inode)
  }

  deleteInode(ino: number): void {
    this.createdTables.delete(ino)
    this.deletedInodes.add(ino)
    this.upsertInodes.delete(ino)
  }

  upsertDentry(dentry: PgdarqAfsDentryRecord): void {
    const key = dentryKey(dentry.parent_ino, dentry.name)
    this.deletedDentries.delete(key)
    this.upsertDentries.set(key, dentry)
  }

  deleteDentry(parentIno: number, name: string): void {
    const key = dentryKey(parentIno, name)
    this.upsertDentries.delete(key)
    this.deletedDentries.set(key, { parentIno, name })
  }

  upsertChunk(ino: number, chunkIndex: number, payload: PgdarqAfsChunkPayload): void {
    const key = chunkKey(ino, chunkIndex)
    this.deletedChunks.delete(key)
    this.upsertChunks.set(key, {
      ino,
      chunkIndex,
      meta: payload.meta,
      data: payload.data,
    })
  }

  deleteChunk(ino: number, chunkIndex: number): void {
    const key = chunkKey(ino, chunkIndex)
    this.upsertChunks.delete(key)
    this.deletedChunks.set(key, { ino, chunkIndex })
  }

  hasChanges(): boolean {
    return (
      this.createdTables.size > 0 ||
      this.deletedInodes.size > 0 ||
      this.deletedChunks.size > 0 ||
      this.deletedDentries.size > 0 ||
      this.upsertInodes.size > 0 ||
      this.upsertDentries.size > 0 ||
      this.upsertChunks.size > 0
    )
  }

  build(): PgdarqAfsFlushBatch {
    if (!this.hasChanges()) {
      return createEmptyFlushBatch()
    }

    return {
      createdTables: [...this.createdTables].sort((a, b) => a - b),
      deletedInodes: [...this.deletedInodes].sort((a, b) => a - b),
      deletedChunks: [...this.deletedChunks.values()].sort(compareChunkDeletes),
      deletedDentries: [...this.deletedDentries.values()].sort(compareDentries),
      upsertInodes: [...this.upsertInodes.values()].sort((a, b) => a.ino - b.ino),
      upsertDentries: [...this.upsertDentries.values()].sort(compareDentries),
      upsertChunks: [...this.upsertChunks.values()].sort(compareChunkRecords),
    }
  }

  reset(): void {
    this.createdTables.clear()
    this.deletedInodes.clear()
    this.deletedChunks.clear()
    this.deletedDentries.clear()
    this.upsertInodes.clear()
    this.upsertDentries.clear()
    this.upsertChunks.clear()
  }
}

function dentryKey(parentIno: number, name: string): string {
  return `${parentIno}:${name}`
}

function chunkKey(ino: number, chunkIndex: number): string {
  return `${ino}:${chunkIndex}`
}

function compareDentries(a: PgdarqAfsDentryDelete | PgdarqAfsDentryRecord, b: PgdarqAfsDentryDelete | PgdarqAfsDentryRecord): number {
  const left = 'parent_ino' in a ? a.parent_ino : a.parentIno
  const right = 'parent_ino' in b ? b.parent_ino : b.parentIno
  return left - right || a.name.localeCompare(b.name)
}

function compareChunkRecords(a: PgdarqAfsChunkRecord, b: PgdarqAfsChunkRecord): number {
  return compareChunkDeletes(a, b)
}

function compareChunkDeletes(
  a: { ino: number; chunkIndex: number },
  b: { ino: number; chunkIndex: number },
): number {
  return a.ino - b.ino || a.chunkIndex - b.chunkIndex
}
