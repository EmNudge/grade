// Shared IndexedDB helpers for the handful of things Grade persists across
// sessions (File System Access handles for footage and projects). The request
// API is callback-based, so `on*` assignment is idiomatic here.
// oxlint-disable unicorn/prefer-add-event-listener

const DB_NAME = 'grade'
const DB_VERSION = 2
const STORES = ['clip-handles', 'recent-projects'] as const
export type StoreName = (typeof STORES)[number]

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      for (const name of STORES) {
        if (!db.objectStoreNames.contains(name)) db.createObjectStore(name)
      }
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('Could not open IndexedDB.'))
  })
}

function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode)
        const req = op(tx.objectStore(store))
        req.onsuccess = () => resolve(req.result as T)
        req.onerror = () => reject(req.error)
        tx.oncomplete = () => db.close()
      }),
  )
}

export function idbGet<T>(store: StoreName, key: string): Promise<T | undefined> {
  return run<T | undefined>(store, 'readonly', (s) => s.get(key))
}

export async function idbPut(store: StoreName, key: string, value: unknown): Promise<void> {
  await run(store, 'readwrite', (s) => s.put(value, key))
}

export async function idbDelete(store: StoreName, key: string): Promise<void> {
  await run(store, 'readwrite', (s) => s.delete(key))
}

export function idbGetAll<T>(store: StoreName): Promise<T[]> {
  return run<T[]>(store, 'readonly', (s) => s.getAll())
}
