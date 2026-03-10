# Main-Thread Minimization Plan for `PgdarqAFS`

## Purpose

This note records the future work needed to minimize main-thread resource
utilization in the browser without making changes now that could conflict with
the in-flight Turso fork work.

The current implementation allows `PGlite` itself to live in a worker, but the
real Turso-backed broker is currently hosted on the main thread via
`installPgdarqAFSHost()`. That means SQL execution is off the UI thread, but the
storage path still depends on the main thread for broker work.

## Constraint

Do not make structural changes now that assume details of the upstream or forked
`@tursodatabase/database-wasm` runtime before the collaborator's Turso fork has
shipped.

In particular, avoid preemptive work that would:

- fork or vendor Turso worker bootstrap code
- hard-code assumptions about Turso worker lifecycle
- add compatibility shims that may need to be undone once the fork lands
- redesign the broker around behavior that only exists in the current Turso
  package

## Current State

Today, the browser architecture is:

1. The app talks to a `PGliteWorker`.
2. `PGlite` and `PgdarqAFS` run inside that worker.
3. `PgdarqAFS` uses synchronous SAB/Atomics coordination for reads.
4. The real persistence broker lives on the main thread and talks to Turso.

This is acceptable for getting `PGlite` off the UI thread, but it is not the
final desired state.

## Target State

The desired future architecture is:

1. The app talks to a `PGliteWorker`.
2. `PGlite` and `PgdarqAFS` run inside that worker.
3. A dedicated broker worker owns Turso, OPFS access, and replication logic.
4. The `PGlite` worker talks to the broker worker over SAB/Atomics plus message
   wakeups.
5. The main thread is reduced to UI work and worker setup only.

## Recommended Future Steps

### 1. Prove the Turso fork in a dedicated worker first

Before changing `PgdarqAFS`, build a minimal standalone proof that does only:

- `connect()` to a file-backed database from a dedicated worker
- create a table
- insert a row
- close
- reopen
- truncate-related write patterns
- close and reopen again

This proof should not involve `PGlite` or `PgdarqAFS`.

If that proof is not stable, the blocker is the Turso runtime, not the
filesystem layer.

### 2. Keep the broker transport boundary stable

The current code already has a useful separation:

- worker-side filesystem logic in `src/pgdarq-afs.ts`
- broker logic in `src/pgdarq-afs-broker.ts`
- browser host bootstrap in `src/pgdarq-afs-browser.ts`

Future work should preserve that separation and swap the transport endpoint,
rather than rewriting the filesystem logic.

The intended change is:

- replace main-thread `MessagePort` hosting with dedicated broker-worker hosting
- keep the filesystem-facing sync RPC shape as close as possible to the current
  one

### 3. Move the real broker out of the main thread

Once the Turso fork can run in a dedicated worker:

- make the dedicated broker worker the primary production path
- keep the main-thread host only as a temporary fallback or dev-only path if
  still needed
- route all real read/flush work to the broker worker, not the main thread

This should remove storage-path work from the UI thread.

### 4. Keep the main thread free of hot-path coordination

After the worker-native broker is available, the main thread should not:

- service chunk reads
- participate in fs flushes
- host the persistent Turso connection
- perform replication bookkeeping

The main thread should only:

- create workers
- wire ports/SABs
- expose app-level APIs to the UI

### 5. Revisit batching only after the worker-native broker exists

Do not tune batching around current main-thread behavior too aggressively.

After the broker is fully worker-hosted, re-evaluate:

- read amplification from chunk fetches
- `syncToFs()` batching size
- strict vs relaxed durability costs
- chunk prefetch and cache behavior
- replication scheduling

The right tuning point depends on the Turso fork's real worker behavior.

### 6. Add performance instrumentation before optimization work

When the Turso fork lands, add benchmarks that separately measure:

- UI-thread blocking time
- `PGlite` worker query latency
- broker worker read latency
- flush latency
- reopen latency
- replication overhead

The key metric is not only total throughput, but whether any measurable work
remains on the main thread during steady-state database use.

### 7. Add lifecycle tests around worker-only persistence

Once the broker moves fully off the main thread, add browser tests for:

- worker startup and shutdown
- reopen after truncate
- reopen after large writes
- interrupted relaxed-durability flushes
- leader-worker handoff if using the multi-tab worker setup
- reconnect after broker worker restart

## Suggested Order of Work After the Turso Fork Ships

1. Validate dedicated-worker Turso behavior in isolation.
2. Switch `PgdarqAFS` broker hosting from main-thread host to broker worker.
3. Re-run browser durability and reopen tests.
4. Reintroduce the hardest reopen-after-truncate coverage.
5. Add main-thread utilization benchmarks.
6. Remove any now-unnecessary main-thread host path.

## What Success Looks Like

Success is not merely that `PGlite` runs in a worker.

Success means:

- the UI thread is not responsible for database reads or flushes
- the storage backend is owned by a dedicated worker
- the main thread only orchestrates workers and renders UI
- browser tests and benchmarks demonstrate that behavior clearly
