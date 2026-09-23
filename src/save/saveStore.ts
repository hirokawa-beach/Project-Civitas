import type { SaveFile } from './serializer';

const DATABASE_NAME = 'project-civitas';
const DATABASE_VERSION = 1;
const STORE_NAME = 'saves';
const QUICK_SAVE_KEY = 'quicksave';

const openDatabase = (): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
  request.onupgradeneeded = () => {
    if (!request.result.objectStoreNames.contains(STORE_NAME)) request.result.createObjectStore(STORE_NAME);
  };
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error ?? new Error('Could not open IndexedDB.'));
});

export const writeQuickSave = async (save: SaveFile): Promise<void> => {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(save, QUICK_SAVE_KEY);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error('Could not write save.'));
  });
  database.close();
};

export const readQuickSave = async (): Promise<SaveFile | undefined> => {
  const database = await openDatabase();
  const save = await new Promise<SaveFile | undefined>((resolve, reject) => {
    const request = database.transaction(STORE_NAME, 'readonly').objectStore(STORE_NAME).get(QUICK_SAVE_KEY);
    request.onsuccess = () => resolve(request.result as SaveFile | undefined);
    request.onerror = () => reject(request.error ?? new Error('Could not read save.'));
  });
  database.close();
  return save;
};
