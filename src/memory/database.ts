import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
export interface MemoryStatement {
  run(...args: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...args: unknown[]): unknown;
  all(...args: unknown[]): unknown[];
}
export interface MemoryDatabase {
  exec(sql: string): void;
  prepare(sql: string): MemoryStatement;
  close(): void;
}
export function openMemoryDatabase(path: string): MemoryDatabase {
  let database: MemoryDatabase;
  try {
    const native = require('node:sqlite') as { DatabaseSync: new (path: string) => MemoryDatabase };
    database = new native.DatabaseSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ERR_UNKNOWN_BUILTIN_MODULE') throw error;
    const fallback = require('better-sqlite3') as new (path: string) => MemoryDatabase;
    database = new fallback(path);
  }
  database.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;');
  return database;
}
