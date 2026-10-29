import './index.css';
import './ui/app.ts';
import * as db from './db/indexeddb.ts';

// Main-process IPC handlers run their IndexedDB work here via executeJavaScript.
(window as unknown as { liltDb: typeof db }).liltDb = db;
