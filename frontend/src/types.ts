export type TopLevelItem = {
  type: 'note' | 'folder';
  id: string;
};

export type Folder = {
  id: string;
  name: string;
  archived?: boolean;
};

export type Note = {
  id: string;
  title: string;
  content: string | null;
  contentHeader: string | null;
  language: string;
  modifiedTime: string;
  archived: boolean;
  folderId?: string;
  syncing?: boolean;
};

export type NoteMetadata = {
  id: string;
  title: string;
  contentHeader: string | null;
  language: string;
  modifiedTime: string;
  archived: boolean;
  folderId?: string;
};

export type NoteList = {
  version: string;
  notes: NoteMetadata[];
  folders?: Folder[];
  archivedTopLevelOrder?: TopLevelItem[];
  lastSync: string;
  lastSyncClientId?: string;
};

export type IntegrityFixOption = {
  id: string;
  label: string;
  description: string;
  params?: Record<string, string>;
};

export type IntegrityIssue = {
  id: string;
  kind: string;
  severity: 'info' | 'warn' | 'error';
  needsUserDecision: boolean;
  noteIds?: string[];
  folderIds?: string[];
  summary: string;
  autoFix?: IntegrityFixOption;
  fixOptions?: IntegrityFixOption[];
};

export type IntegrityFixSelection = {
  issueId: string;
  fixId: string;
};

export type IntegrityRepairSummary = {
  applied: number;
  skipped: number;
  errors: number;
  messages?: string[];
};

// ファイルノートの型
export type FileNote = {
  id: string;
  filePath: string;
  fileName: string;
  content: string;
  originalContent: string;
  language: string;
  modifiedTime: string;
};

// 設定の型
export type Settings = {
  fontFamily: string;
  fontSize: number;
  isDarkMode: boolean;
  editorTheme: string;
  wordWrap: string;
  minimap: boolean;
  windowWidth: number;
  windowHeight: number;
  windowX: number;
  windowY: number;
  isMaximized: boolean;
  isDebug: boolean;
  enableConflictBackup: boolean;
  markdownPreviewOnLeft: boolean;
  sidebarWidth?: number;
  splitPaneSize?: number;
  markdownPreviewPaneSize?: number;
  markdownPreviewVisible?: boolean;
  isSplit?: boolean;
  uiLanguage?: 'system' | 'en' | 'ja';
};

export const DEFAULT_EDITOR_FONT_FAMILY =
  '"Cascadia Mono", "Cascadia Code", Consolas, "BIZ UDGothic", "Yu Gothic UI", "Meiryo UI", Meiryo, "MS Gothic", Monaco, "Courier New", monospace';

export const DEFAULT_UI_FONT_FAMILY =
  '"Yu Gothic UI", "Meiryo UI", Meiryo, "Hiragino Kaku Gothic ProN", "Segoe UI", sans-serif';

export type EditorPane = 'left' | 'right';

export type PaneState = {
  note: Note | null;
  fileNote: FileNote | null;
};

// デフォルトの設定
export const DEFAULT_EDITOR_SETTINGS: Partial<Settings> = {
  fontFamily: DEFAULT_EDITOR_FONT_FAMILY,
  fontSize: 14,
  isDarkMode: false,
  editorTheme: 'default',
  wordWrap: 'off',
  minimap: true,
  isDebug: false,
  enableConflictBackup: true,
  markdownPreviewOnLeft: false,
  uiLanguage: 'system',
};
