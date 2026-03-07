# Example Structure Guidelines

This document defines how examples in this repository should be structured.

## Goals

- Keep parent processes free of direct pglite/sqlite/graft logic.
- Isolate graft usage per process (one graft-loaded process at a time).
- Ensure child processes initialize sqlite3mc and graft before any pglite usage.
- Keep all example artifacts in stable, inspectable paths under `artifacts/examples/`.

## Required Layout

Each example must live in its own directory under `examples/` and use the naming pattern below:

- `<example>-parent.ts`
- `<example>-utils.ts`
- `<example>-child-<role>.ts` (one or more)

Example:

- `examples/pglite-cryptograft/pglite-cryptograft-parent.ts`
- `examples/pglite-cryptograft/pglite-cryptograft-utils.ts`
- `examples/pglite-cryptograft/pglite-cryptograft-child-writer.ts`
- `examples/pglite-cryptograft/pglite-cryptograft-child-publish.ts`
- `examples/pglite-cryptograft/pglite-cryptograft-child-replica.ts`
- `examples/pglite-cryptograft/pglite-cryptograft-child-verify.ts`

## Parent Responsibilities

Parent scripts should:

- Build the example environment and filesystem layout.
- Create per-client graft configs.
- Spawn child processes with `Bun.spawnSync()`.
- Forward stdout/stderr from children.
- Fail fast if any child exits non-zero.

Parent scripts should **not**:

- Open pglite.
- Execute SQL.
- Run graft pragmas directly.

## Child Responsibilities

Each child script should:

- Import shared helpers from `<example>-utils.ts`.
- Load sqlite3mc and graft extension at startup.
- Perform only the role-specific portion of the flow.
- Read/write shared state through files under the example artifact directory (for example remote log IDs).

## Artifact Placement

Examples should write into:

- `artifacts/examples/<example>/...`

Use deterministic, inspectable paths instead of temporary directories.

## Current pglite-cryptograft Flow

`pglite-cryptograft` is split into child roles:

1. `writer`: initializes client-1 pglite and writes data.
2. `publish`: imports into graft and pushes; persists discovered remote log ID.
3. `replica`: clones/pulls on client-2 and exports sqlite metadata DB.
4. `verify`: opens client-2 pglite and confirms expected replicated rows.

This split avoids cross-role graft state sharing in a single process and makes each step independently runnable/debuggable.
