// IndexedDB-backed cache for map tiles and Overpass responses.
//
// Every remote byte the game fetches lands here, so revisiting a location is
// instant and repeat play does not hammer the free public APIs. Falls back to
// an in-memory Map if IndexedDB is unavailable (private browsing, file://).

const DB_NAME = 'earthwalk-cache';
const DB_VERSION = 1;
const STORE = 'blobs';

let dbPromise = null;
const memory = new Map();
let usingMemory = false;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    let req;
    try {
      req = indexedDB.open(DB_NAME, DB_VERSION);
    } catch (e) {
      usingMemory = true;
      return resolve(null);
    }
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const os = db.createObjectStore(STORE, { keyPath: 'key' });
        os.createIndex('ts', 'ts');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { usingMemory = true; resolve(null); };
    req.onblocked = () => { usingMemory = true; resolve(null); };
    // Some engines never fire any of the above on file:// - do not hang forever.
    setTimeout(() => { if (!usingMemory) { usingMemory = true; resolve(null); } }, 4000);
  });
  return dbPromise;
}

/** Look up a cached entry. Returns the stored value or undefined. */
export async function cacheGet(key, maxAgeMs = Infinity) {
  if (memory.has(key)) {
    const e = memory.get(key);
    if (Date.now() - e.ts <= maxAgeMs) return e.value;
    memory.delete(key);
  }
  const db = await openDb();
  if (!db) return undefined;
  return new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readonly');
      const req = tx.objectStore(STORE).get(key);
      req.onsuccess = () => {
        const rec = req.result;
        if (!rec) return resolve(undefined);
        if (Date.now() - rec.ts > maxAgeMs) return resolve(undefined);
        resolve(rec.value);
      };
      req.onerror = () => resolve(undefined);
    } catch (e) { resolve(undefined); }
  });
}

/** Store a value. Values must be structured-cloneable (ArrayBuffer, object...). */
export async function cachePut(key, value) {
  memory.set(key, { ts: Date.now(), value });
  // Keep the hot in-memory tier bounded.
  if (memory.size > 600) {
    const drop = memory.size - 500;
    let i = 0;
    for (const k of memory.keys()) { if (i++ >= drop) break; memory.delete(k); }
  }
  const db = await openDb();
  if (!db) return;
  try {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put({ key, ts: Date.now(), value });
  } catch (e) { /* quota or closed db - the memory tier still serves this session */ }
}

/** Approximate cache size, for the settings screen. */
export async function cacheStats() {
  const db = await openDb();
  let entries = 0;
  if (db) {
    entries = await new Promise((resolve) => {
      try {
        const req = db.transaction(STORE, 'readonly').objectStore(STORE).count();
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => resolve(0);
      } catch (e) { resolve(0); }
    });
  }
  let bytes = 0;
  if (navigator.storage && navigator.storage.estimate) {
    try { bytes = (await navigator.storage.estimate()).usage || 0; } catch (e) { /* ignore */ }
  }
  return { entries: entries + memory.size, bytes, persistent: !usingMemory };
}

export async function cacheClear() {
  memory.clear();
  const db = await openDb();
  if (!db) return;
  await new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
    } catch (e) { resolve(); }
  });
}
