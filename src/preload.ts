import { contextBridge, ipcRenderer } from 'electron';
import type {
  AiCompleteRequest,
  Api,
  CalendarEvent,
  Store,
  SttProgress,
  TranscribeRequest,
} from './shared/types.ts';

const api: Api = {
  load: () => ipcRenderer.invoke('store:load') as Promise<Store>,
  save: (store: Store) => ipcRenderer.invoke('store:save', store),
  aiConfig: () => ipcRenderer.invoke('ai:config'),
  setAiConfig: (config) => ipcRenderer.invoke('ai:set-config', config),
  complete: (request: AiCompleteRequest) =>
    ipcRenderer.invoke('ai:complete', request),
  transcribe: (request: TranscribeRequest) =>
    ipcRenderer.invoke('ai:transcribe', request),
  sttDownload: (source) => ipcRenderer.invoke('stt:download', source),
  onSttProgress: (callback: (progress: SttProgress) => void) => {
    const listener = (_event: unknown, progress: SttProgress) =>
      callback(progress);
    ipcRenderer.on('stt:progress', listener);
    return () => ipcRenderer.removeListener('stt:progress', listener);
  },
  calendarStatus: () => ipcRenderer.invoke('calendar:status'),
  calendarConnect: (
    request: import('./shared/types.ts').CalendarConnectRequest,
  ) => ipcRenderer.invoke('calendar:connect', request),
  calendarDisconnect: () => ipcRenderer.invoke('calendar:disconnect'),
  calendarEvents: () => ipcRenderer.invoke('calendar:events'),
  shareUrl: (token: string) => ipcRenderer.invoke('share:url', token),
  openShare: (token: string) => ipcRenderer.invoke('share:open', token),
  onSuspend: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('power:suspend', listener);
    return () => ipcRenderer.removeListener('power:suspend', listener);
  },
  setMeetingDetectionEnabled: (enabled: boolean) =>
    ipcRenderer.invoke('meeting:set-enabled', enabled) as Promise<void>,
  onMeetingDetected: (callback: (event: CalendarEvent) => void) => {
    const listener = (_event: unknown, event: CalendarEvent) => callback(event);
    ipcRenderer.on('meeting:detected', listener);
    return () => ipcRenderer.removeListener('meeting:detected', listener);
  },
  audioRetention: {
    writePending: (data: {
      noteId: string;
      source: 'mic' | 'system';
      arrayBuffer: ArrayBuffer;
      startMs: number;
      endMs: number;
      speechStartMs: number;
      speechEndMs: number;
      baseMs: number;
      language: string;
      prompt?: string;
    }) => ipcRenderer.invoke('audio-retention:write', data),
    readPending: () => ipcRenderer.invoke('audio-retention:read-pending'),
    readChunk: (filePath: string) =>
      ipcRenderer.invoke(
        'audio-retention:read-chunk',
        filePath,
      ) as Promise<ArrayBuffer>,
    deletePending: (filePath: string) =>
      ipcRenderer.invoke('audio-retention:delete', filePath),
    incrementAttempts: (filePath: string) =>
      ipcRenderer.invoke('audio-retention:increment-attempts', filePath),
  },
  platform: process.platform,
};

contextBridge.exposeInMainWorld('api', api);
