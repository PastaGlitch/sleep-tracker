// Everything is stored on the phone only, in IndexedDB. Nothing is uploaded.

const DB_NAME = 'sleep-tracker';
const DB_VERSION = 1;
let dbPromise;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('nights')) d.createObjectStore('nights', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('clips')) {
          const clips = d.createObjectStore('clips', { keyPath: 'id' });
          clips.createIndex('nightId', 'nightId');
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function tx(store, mode, fn) {
  const d = await db();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const result = fn(t.objectStore(store));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : result);
    t.onerror = () => reject(t.error);
  });
}

// Store a plain copy so later edits to the live object don't race the write.
export const saveNight = night => tx('nights', 'readwrite', s => s.put(JSON.parse(JSON.stringify(night))));
export const getNight = id => tx('nights', 'readonly', s => s.get(id));
export const getAllNights = async () => (await tx('nights', 'readonly', s => s.getAll())).sort((a, b) => b.id - a.id);
export const saveClip = clip => tx('clips', 'readwrite', s => s.put(clip));
export const getClip = id => tx('clips', 'readonly', s => s.get(id));
export const deleteClip = id => tx('clips', 'readwrite', s => s.delete(id));

export async function deleteNight(id) {
  await tx('nights', 'readwrite', s => s.delete(id));
  const d = await db();
  await new Promise((resolve, reject) => {
    const t = d.transaction('clips', 'readwrite');
    const idx = t.objectStore('clips').index('nightId');
    idx.openCursor(IDBKeyRange.only(id)).onsuccess = e => {
      const c = e.target.result;
      if (c) { c.delete(); c.continue(); }
    };
    t.oncomplete = resolve;
    t.onerror = () => reject(t.error);
  });
}

// Ask the browser not to clear our data when the phone runs low on space.
export async function requestPersistence() {
  try { return navigator.storage && navigator.storage.persist ? await navigator.storage.persist() : false; }
  catch { return false; }
}

export async function storageEstimate() {
  try { return navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null; }
  catch { return null; }
}

// Backup without audio clips (they are large); restore merges by night id.
export async function exportData() {
  const nights = await getAllNights();
  return JSON.stringify({ app: 'sleep-tracker', exported: new Date().toISOString(), nights }, null, 0);
}

export async function importData(json) {
  const data = JSON.parse(json);
  if (data.app !== 'sleep-tracker' || !Array.isArray(data.nights)) throw new Error('Not a Sleep Tracker backup');
  let added = 0;
  for (const n of data.nights) {
    if (await getNight(n.id)) continue; // never overwrite a night already on this phone
    n.events = (n.events || []).map(e => ({ ...e, clipId: null }));
    await saveNight(n);
    added++;
  }
  return added;
}
