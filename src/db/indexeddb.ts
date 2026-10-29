import { openDB, type DBSchema, type IDBPDatabase } from 'idb';
import { mergeSettings } from '../shared/logic.ts';
import type {
  Note,
  Settings,
  Space,
  Folder,
  Template,
  Recipe,
  ChatThread,
  Workspace,
  User,
  Store,
} from '../shared/types.ts';

const DB_NAME = 'lilt-db';
const DB_VERSION = 2;

interface LiltSchema extends DBSchema {
  workspace: { key: string; value: Workspace };
  user: { key: string; value: User };
  spaces: { key: string; value: Space };
  folders: { key: string; value: Folder };
  notes: { key: string; value: Note };
  templates: { key: string; value: Template };
  recipes: { key: string; value: Recipe };
  threads: { key: string; value: ChatThread };
  settings: { key: string; value: Settings };
  migrationState: {
    key: string;
    value: { done?: boolean; version?: number; savedAt?: string };
  };
}

const STORES = [
  'workspace',
  'user',
  'spaces',
  'folders',
  'notes',
  'templates',
  'recipes',
  'threads',
  'settings',
  'migrationState',
] as const;

const COLLECTIONS = [
  'spaces',
  'folders',
  'notes',
  'templates',
  'recipes',
  'threads',
] as const;

type Collection = (typeof COLLECTIONS)[number];
type SavedRows = Record<Collection, Map<string, string>>;

let dbInstance: IDBPDatabase<LiltSchema> | null = null;
/** Last rows written to IndexedDB, so a save only touches what changed. */
let savedRows: SavedRows | null = null;

function rowsOf(store: Store): SavedRows {
  const rows = {} as SavedRows;
  for (const name of COLLECTIONS) {
    const ids = new Map<string, string>();
    for (const row of store[name]) ids.set(row.id, JSON.stringify(row));
    rows[name] = ids;
  }
  return rows;
}

export async function openDatabase(): Promise<IDBPDatabase<LiltSchema>> {
  if (dbInstance) return dbInstance;

  dbInstance = await openDB<LiltSchema>(DB_NAME, DB_VERSION, {
    upgrade(db) {
      if (db.objectStoreNames.contains('segments' as never)) {
        // Version 1 kept a duplicate transcript here that nothing ever read.
        db.deleteObjectStore('segments' as never);
      }
      if (!db.objectStoreNames.contains('workspace')) {
        db.createObjectStore('workspace');
      }
      if (!db.objectStoreNames.contains('user')) {
        db.createObjectStore('user');
      }
      if (!db.objectStoreNames.contains('spaces')) {
        db.createObjectStore('spaces', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('folders')) {
        db.createObjectStore('folders', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('notes')) {
        db.createObjectStore('notes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('templates')) {
        db.createObjectStore('templates', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('recipes')) {
        db.createObjectStore('recipes', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('threads')) {
        db.createObjectStore('threads', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('settings')) {
        db.createObjectStore('settings');
      }
      if (!db.objectStoreNames.contains('migrationState')) {
        db.createObjectStore('migrationState');
      }
    },
  });

  return dbInstance;
}

export async function migrateFromJson(jsonStore: Store): Promise<void> {
  const db = await openDatabase();
  const tx = db.transaction(STORES, 'readwrite');

  await tx.objectStore('workspace').put(jsonStore.workspace, 'workspace');
  await tx.objectStore('user').put(jsonStore.user, 'user');

  for (const name of COLLECTIONS) {
    for (const row of jsonStore[name]) await tx.objectStore(name).put(row);
  }

  await tx
    .objectStore('settings')
    .put(mergeSettings(jsonStore.settings), 'settings');
  await tx
    .objectStore('migrationState')
    .put({ done: true, version: DB_VERSION }, 'migration');
  await tx
    .objectStore('migrationState')
    .put({ savedAt: new Date().toISOString() }, 'save');
  await tx.done;

  savedRows = rowsOf(jsonStore);
}

export async function loadStore(): Promise<Store> {
  const db = await openDatabase();
  const [
    workspace,
    user,
    spaces,
    folders,
    notes,
    templates,
    recipes,
    threads,
    settings,
    migrationState,
  ] = await Promise.all([
    db.get('workspace', 'workspace'),
    db.get('user', 'user'),
    db.getAll('spaces'),
    db.getAll('folders'),
    db.getAll('notes'),
    db.getAll('templates'),
    db.getAll('recipes'),
    db.getAll('threads'),
    db.get('settings', 'settings'),
    db.get('migrationState', 'migration'),
  ]);

  const store = {
    workspace: workspace ?? { id: 'workspace-main', name: 'My Workspace' },
    user: user ?? { id: 'user-main', name: 'User', email: '' },
    spaces: spaces ?? [],
    folders: folders ?? [],
    notes: notes ?? [],
    templates: templates ?? [],
    recipes: recipes ?? [],
    threads: threads ?? [],
    settings: mergeSettings(settings),
    migrationDone: migrationState?.done ?? false,
  } as Store & { migrationDone: boolean };

  savedRows = rowsOf(store);
  return store;
}

export async function saveStore(store: Store): Promise<{ savedAt: string }> {
  const db = await openDatabase();
  const savedAt = new Date().toISOString();
  const nextRows = rowsOf(store);
  const tx = db.transaction(STORES, 'readwrite');

  for (const name of COLLECTIONS) {
    const previous = savedRows?.[name] ?? new Map<string, string>();
    const rows = store[name];
    const current = nextRows[name];
    const objectStore = tx.objectStore(name);
    for (const row of rows) {
      if (previous.get(row.id) !== current.get(row.id)) {
        await objectStore.put(row);
      }
    }
    const ids = new Set(rows.map((row) => row.id));
    for (const id of previous.keys()) {
      if (!ids.has(id)) await objectStore.delete(id);
    }
  }

  await tx.objectStore('workspace').put(store.workspace, 'workspace');
  await tx.objectStore('user').put(store.user, 'user');
  await tx
    .objectStore('settings')
    .put(mergeSettings(store.settings), 'settings');
  // Marker for main: lets it tell whether store.json is newer (failed save).
  await tx.objectStore('migrationState').put({ savedAt }, 'save');
  await tx.done;

  savedRows = nextRows;
  return { savedAt };
}

/** Timestamp of the last IndexedDB commit; backfills for older databases. */
export async function lastSavedAt(): Promise<string> {
  const db = await openDatabase();
  const record = await db.get('migrationState', 'save');
  if (record?.savedAt) return record.savedAt;

  // Databases created before this marker existed: trust IndexedDB from now on.
  const now = new Date().toISOString();
  await db.put('migrationState', { savedAt: now }, 'save');
  return now;
}

export async function isMigrationDone(): Promise<boolean> {
  const db = await openDatabase();
  const state = await db.get('migrationState', 'migration');
  return state?.done ?? false;
}
