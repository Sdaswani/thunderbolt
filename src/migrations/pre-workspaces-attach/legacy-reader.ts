/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/**
 * Read-only accessor for the pre-Workspaces SQLite database
 * (`thunderbolt-sync.db` or `thunderbolt.db`). Spins up a *second* wa-sqlite
 * engine — with its own VFS state — so the workspaces-build's already-open
 * engine doesn't have to ATTACH the legacy file. ATTACH silently no-ops on
 * the IDB-backed cohort (Chrome / Firefox / Edge web) because the in-process
 * VFS state collides between the two databases; a fresh engine sidesteps the
 * collision entirely.
 *
 * The wa-sqlite modules are loaded via `import()` with `@vite-ignore` rather
 * than static imports because each module ships its WASM as a sibling file
 * referenced through `new URL('./*.wasm', import.meta.url)`. Static imports
 * are rewritten by Vite to point at the bundled chunk, where the WASM sibling
 * doesn't exist — the engine then opens against an empty in-memory file
 * instead of the user's actual data. The `@vite-ignore` hint preserves the
 * runtime URL so the WASM resolves correctly. PowerSync's own adapter loads
 * the same family of factories with the same pattern.
 */

import { SQLITE_ROW } from '@journeyapps/wa-sqlite'

export type LegacyBackend = 'idb' | 'opfs'

export type LegacyReader = {
  /** True iff a table or view with this name exists in the legacy file. */
  hasTable(name: string): Promise<boolean>
  /** Column names in `PRAGMA table_info` order. Empty when the table is missing. */
  columnNames(name: string): Promise<string[]>
  /**
   * Returns every row of `name` as an array of values aligned positionally
   * with `columnNames(name)`. Empty when the table is missing. Binary columns
   * arrive as `Uint8Array`; everything else maps to its JS primitive.
   */
  selectAll(name: string): Promise<unknown[][]>
  /** Release the engine. Idempotent. */
  close(): Promise<void>
}

const quoteId = (name: string): string => `"${name.replace(/"/g, '""')}"`
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`

/* eslint-disable @typescript-eslint/no-explicit-any */
type WaSqliteApi = {
  Factory: (module: unknown) => SQLiteApi
}
type SQLiteApi = {
  open_v2: (filename: string) => Promise<number>
  close: (db: number) => Promise<number>
  statements: (db: number, sql: string) => AsyncIterable<number>
  step: (stmt: number) => Promise<number>
  column: (stmt: number, i: number) => unknown
  column_count: (stmt: number) => number
  vfs_register: (vfs: unknown, makeDefault: boolean) => number
}

const loadAsyncEngine = async (): Promise<{ sqlite3: SQLiteApi; module: unknown }> => {
  const sqliteApi = (await import('@journeyapps/wa-sqlite')) as unknown as WaSqliteApi
  const factoryMod = (await import(
    /* @vite-ignore */ '@journeyapps/wa-sqlite/dist/wa-sqlite-async-dynamic-main.mjs'
  )) as any
  const factory = (factoryMod.default ?? factoryMod) as () => Promise<unknown>
  const module = await factory()
  return { sqlite3: sqliteApi.Factory(module), module }
}

const loadVfs = async (backend: LegacyBackend, filename: string, module: unknown): Promise<unknown> => {
  if (backend === 'idb') {
    const vfsMod = (await import(/* @vite-ignore */ '@journeyapps/wa-sqlite/src/examples/IDBBatchAtomicVFS.js')) as any
    return await vfsMod.IDBBatchAtomicVFS.create(filename, module)
  }
  const vfsMod = (await import(/* @vite-ignore */ '@journeyapps/wa-sqlite/src/examples/OPFSCoopSyncVFS.js')) as any
  return await vfsMod.OPFSCoopSyncVFS.create(filename, module)
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * Open the legacy SQLite database for read-only access. The caller is
 * responsible for calling `close()` on the returned reader to release the
 * engine.
 */
export const openLegacyReader = async (filename: string, backend: LegacyBackend): Promise<LegacyReader> => {
  const { sqlite3, module } = await loadAsyncEngine()
  const vfs = await loadVfs(backend, filename, module)
  // The second argument makes this VFS the default for new connections from
  // *this* engine — safe because it's a fresh engine with no other state.
  sqlite3.vfs_register(vfs, true)
  const dbHandle = await sqlite3.open_v2(filename)
  let closed = false

  // wa-sqlite is single-threaded per engine: concurrent `statements()` /
  // `step()` calls against the same dbHandle deadlock. We serialize every
  // query through a single chained promise so callers can issue Promise.all
  // (or just two awaits that overlap by accident) without worrying about it.
  // The existing `wa-sqlite-worker.ts` has an equivalent queue for the same
  // reason.
  let queue: Promise<unknown> = Promise.resolve()
  const runQuery = <T>(sql: string, readRow: (stmt: number) => T): Promise<T[]> => {
    const next = queue.then(async () => {
      const rows: T[] = []
      for await (const stmt of sqlite3.statements(dbHandle, sql)) {
        while ((await sqlite3.step(stmt)) === SQLITE_ROW) {
          rows.push(readRow(stmt))
        }
      }
      return rows
    })
    // Swallow rejection on the chain so one failed query doesn't poison
    // subsequent ones. The caller still sees the rejection via `next`.
    queue = next.catch(() => undefined)
    return next
  }

  const hasTable = async (name: string): Promise<boolean> => {
    const sql = `SELECT 1 FROM sqlite_master WHERE type IN ('table','view') AND name = ${quoteLiteral(name)} LIMIT 1`
    const rows = await runQuery(sql, () => 1)
    return rows.length > 0
  }

  const columnNames = async (name: string): Promise<string[]> => {
    if (!(await hasTable(name))) {
      return []
    }
    // PRAGMA table_info rows: [cid, name, type, notnull, dflt_value, pk]
    return runQuery(`PRAGMA table_info(${quoteId(name)})`, (stmt) => sqlite3.column(stmt, 1) as string)
  }

  const selectAll = async (name: string): Promise<unknown[][]> => {
    if (!(await hasTable(name))) {
      return []
    }
    return runQuery(`SELECT * FROM ${quoteId(name)}`, (stmt) => {
      const colCount = sqlite3.column_count(stmt)
      const row: unknown[] = new Array(colCount)
      for (let i = 0; i < colCount; i++) {
        row[i] = sqlite3.column(stmt, i)
      }
      return row
    })
  }

  const close = async (): Promise<void> => {
    if (closed) {
      return
    }
    closed = true
    await sqlite3.close(dbHandle)
  }

  return { hasTable, columnNames, selectAll, close }
}
