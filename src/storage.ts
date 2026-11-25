const DATABASE_NAME = 'notes-app-storage';
const DATABASE_VERSION = 1;
const STORE_NAME = 'app-state';

let databasePromise: Promise<IDBDatabase> | null = null;

function openDatabase(): Promise<IDBDatabase> {
  if (typeof indexedDB === 'undefined') {
    return Promise.reject(new Error('IndexedDB is not available in this browser.'));
  }

  if (!databasePromise) {
    const opening = new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);

      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE_NAME)) {
          database.createObjectStore(STORE_NAME);
        }
      };
      request.onsuccess = () => {
        const database = request.result;
        database.onversionchange = () => database.close();
        resolve(database);
      };
      request.onerror = () => reject(request.error || new Error('Could not open the notes database.'));
      request.onblocked = () => reject(new Error('The notes database upgrade is blocked by another open tab.'));
    });

    databasePromise = opening.catch((error: unknown) => {
      databasePromise = null;
      throw error;
    });
  }

  return databasePromise;
}

export async function readStorage(key: string): Promise<unknown> {
  const database = await openDatabase();
  const storedValue = await new Promise<unknown>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readonly');
    const request = transaction.objectStore(STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not read notes from the database.'));
    transaction.onabort = () => reject(transaction.error || new Error('Reading notes was aborted.'));
  });

  return storedValue === undefined ? null : storedValue;
}

export async function writeStorage(key: string, value: unknown): Promise<void> {
  const database = await openDatabase();
  await new Promise<void>((resolve, reject) => {
    const transaction = database.transaction(STORE_NAME, 'readwrite');
    transaction.objectStore(STORE_NAME).put(value, key);
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error || new Error('Could not save notes to the database.'));
    transaction.onabort = () => reject(transaction.error || new Error('Saving notes was aborted.'));
  });
}
