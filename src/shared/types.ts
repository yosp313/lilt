export type ID = string;
export type Plan = 'free' | 'business' | 'enterprise';
export type NoteStatus = 'draft' | 'recording' | 'paused' | 'ended';
export type SpeakerSource = 'mic' | 'system';

export interface Workspace {
  id: ID;
  name: string;
  domain: string;
  plan: Plan;
}

export interface User {
  id: ID;
  name: string;
  email: string;
}

export interface Space {
  id: ID;
  kind: 'personal' | 'team';
  name: string;
  icon: string;
  description: string;
}

export interface Folder {
  id: ID;
  spaceId: ID;
  parentId: ID | null;
  name: string;
  icon: string;
  description: string;
}

export interface Segment {
  id: ID;
  source: SpeakerSource;
  speaker: string;
  text: string;
  startMs: number;
  endMs: number;
}

export interface SourceRef {
  kind: 'transcript' | 'raw' | 'unverified';
  quote: string;
  segmentId?: ID;
}

export interface Bullet {
  id: ID;
  text: string;
  source: SourceRef | null;
}

export interface Section {
  id: ID;
  heading: string;
  bullets: Bullet[];
}

export interface EnhancedNote {
  templateId: ID | null;
  generatedAt: string;
  model: string;
  sections: Section[];
}

export type ShareMode = 'off' | 'anyone';

export interface ShareSettings {
  mode: ShareMode;
  token: string | null;
}

export interface CalendarEvent {
  id?: ID;
  title: string;
  start: string;
  end: string;
  meetingUrl?: string;
  attendees: string[];
  agenda?: string;
}

export type CalendarProvider = 'google' | 'microsoft';

export interface CalendarStatus {
  connected: boolean;
  provider: CalendarProvider | null;
  email: string;
  name: string;
  lastSyncedAt: string | null;
  error: string | null;
}

export interface CalendarConnectRequest {
  provider: CalendarProvider;
  clientId: string;
  clientSecret?: string;
}

export interface Note {
  id: ID;
  spaceId: ID;
  folderIds: ID[];
  title: string;
  status: NoteStatus;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  endedAt: string | null;
  durationMs: number;
  attendees: string[];
  calendarEvent: CalendarEvent | null;
  rawNotes: string;
  enhanced: EnhancedNote | null;
  templateId: ID | null;
  transcript: Segment[];
  deletedAt: string | null;
  share: ShareSettings;
}

export interface Template {
  id: ID;
  name: string;
  prompt: string;
  sections: string[];
  builtin: boolean;
  visibility: 'private' | 'org';
}

export interface Recipe {
  id: ID;
  name: string;
  prompt: string;
  scope: 'single' | 'multiple';
  model: 'auto' | 'standard' | 'thinking';
  visibility: 'private' | 'workspace';
}

export type ScopeType = 'note' | 'folder' | 'space' | 'all' | 'person';
export type ChatModel = 'auto' | 'standard' | 'thinking';

export interface Scope {
  type: ScopeType;
  id?: ID;
  label: string;
}

export interface ChatMessage {
  id: ID;
  role: 'user' | 'assistant';
  content: string;
  model?: string;
  createdAt: string;
}

export interface ChatThread {
  id: ID;
  scope: Scope;
  title: string;
  model: ChatModel;
  createdAt: string;
  messages: ChatMessage[];
}

export interface Settings {
  historyDays: number;
  notifications: boolean;
  includeSystemAudio: boolean;
  sttLanguage: string;
  autoEnhance: boolean;
}

export interface Store {
  workspace: Workspace;
  user: User;
  spaces: Space[];
  folders: Folder[];
  notes: Note[];
  templates: Template[];
  recipes: Recipe[];
  threads: ChatThread[];
  settings: Settings;
}

export interface RetrievalHit {
  noteId: ID;
  title: string;
  createdAt: string;
  snippets: string[];
  score: number;
}

export interface SharedNote {
  title: string;
  createdAt: string;
  attendees: string[];
  workspaceName: string;
  sections: { heading: string; bullets: string[] }[];
  hasSummary: boolean;
}

export interface AiConfig {
  configured: boolean;
  baseUrl: string;
  chatModel: string;
  thinkingModel: string;
  sttModel: string;
  sttLanguage: string;
  keyStored: boolean;
}

export interface AiCompleteRequest {
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  model: string;
  json?: boolean;
}

export interface TranscribeRequest {
  data: ArrayBuffer;
  mime: string;
  language: string;
}

export interface Api {
  load(): Promise<Store>;
  save(store: Store): Promise<{ savedAt: string }>;
  aiConfig(): Promise<AiConfig>;
  setAiConfig(cfg: {
    baseUrl: string;
    chatModel: string;
    thinkingModel: string;
    sttModel: string;
    sttLanguage: string;
    apiKey?: string;
  }): Promise<AiConfig>;
  complete(req: AiCompleteRequest): Promise<{ text: string }>;
  transcribe(req: TranscribeRequest): Promise<{ text: string }>;
  calendarStatus(): Promise<CalendarStatus>;
  calendarConnect(req: CalendarConnectRequest): Promise<CalendarStatus>;
  calendarDisconnect(): Promise<CalendarStatus>;
  calendarEvents(): Promise<CalendarEvent[]>;
  shareUrl(token: string): Promise<string>;
  openShare(token: string): Promise<void>;
  onSuspend(cb: () => void): () => void;
  platform: string;
}
