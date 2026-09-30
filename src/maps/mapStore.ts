import { assertMapAsset, duplicateMapAsset, type MapAsset } from './mapAsset';

/** Separate database: map editing cannot overwrite the city's quicksave store. */
const openMaps = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open('project-civitas-maps', 1);
  request.onupgradeneeded = () => request.result.createObjectStore('maps', { keyPath: 'id' });
  request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
});
async function transaction<T>(mode: IDBTransactionMode, operation: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openMaps();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction('maps', mode); const request = operation(tx.objectStore('maps')); let result: T;
      request.onsuccess = () => { result = request.result; };
      tx.oncomplete = () => resolve(result); tx.onerror = tx.onabort = () => reject(tx.error ?? request.error ?? new Error('Map Library storage failed.'));
    });
  } finally { db.close(); }
}
export async function listUserMaps(): Promise<MapAsset[]> { return transaction('readonly', store => store.getAll()); }
export async function readMapAsset(id: string): Promise<MapAsset | undefined> { return transaction('readonly', store => store.get(id)); }
export async function saveMapAsset(asset: MapAsset, replace = false): Promise<void> {
  assertMapAsset(asset); if (asset.id.startsWith('builtin-')) throw new Error('Duplicate a built-in map before saving edits.');
  await transaction('readwrite', store => replace ? store.put(structuredClone(asset)) : store.add(structuredClone(asset)));
}
export async function deleteMapAsset(id: string): Promise<void> {
  if (id.startsWith('builtin-')) throw new Error('Built-in maps cannot be deleted.');
  await transaction('readwrite', store => store.delete(id));
}
export async function renameMapAsset(id: string, name: string, description?: string): Promise<void> {
  const asset = await readMapAsset(id); if (!asset) throw new Error('Map Asset does not exist.');
  await saveMapAsset({ ...asset, name: name.trim(), description: description ?? asset.description }, true);
}
export async function duplicateStoredMap(asset: MapAsset): Promise<MapAsset> {
  const copy = duplicateMapAsset(asset); await saveMapAsset(copy); return copy;
}
