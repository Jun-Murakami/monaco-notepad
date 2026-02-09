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
};

export type EditorPane = 'left' | 'right';

export type PaneState = {
	note: Note | null;
	fileNote: FileNote | null;
};

// デフォルトの設定
export const DEFAULT_EDITOR_SETTINGS: Partial<Settings> = {
	fontFamily: 'Consolas, Monaco, "Courier New", monospace',
	fontSize: 14,
	isDarkMode: false,
	editorTheme: 'default',
	wordWrap: 'off',
	minimap: true,
	isDebug: false,
};
