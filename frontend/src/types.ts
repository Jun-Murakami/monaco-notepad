// ノートのメタデータを管理するための型
export type NoteMetadata = {
  id: string;
  title: string;
  contentHeader: string | null;  // アーカイブ時のコンテンツヘッダー
  language: string;
  modifiedTime: string;
  archived: boolean;
}

// ノートリストの型
export type NoteList = {
  version: string;  // 将来の互換性のため
  notes: NoteMetadata[];
  lastSync: string;  // 最後の同期時刻
}

export type Settings = {
  fontFamily: string;
  fontSize: number;
  isDarkMode: boolean;
  wordWrap: string;
  minimap: boolean;
  windowWidth: number;
  windowHeight: number;
  windowX: number;
  windowY: number;
  isMaximized: boolean;
  isDebug: boolean;
}

export type EditorSettings = {
  fontFamily: string;
  fontSize: number;
  isDarkMode: boolean;
  wordWrap: 'on' | 'off';
  minimap: boolean;
  windowWidth: number;
  windowHeight: number;
  windowX: number;
  windowY: number;
  isMaximized: boolean;
  isDebug: boolean;
};

export const DEFAULT_EDITOR_SETTINGS: Partial<EditorSettings> = {
  fontFamily: 'Consolas, Monaco, "Courier New", monospace',
  fontSize: 14,
  isDarkMode: false,
  wordWrap: 'off',
  minimap: true,
  isDebug: false,
};

// 基底となるノートの型
interface BaseNote {
  id: string;
  content: string;
  language: string;
  modifiedTime: string;
}

// メモリ上で管理されるノート
export interface MemoryNote extends BaseNote {
  type: 'memory';
  title: string;
  contentHeader: string | null;
  archived: boolean;
}

// ファイルシステム上のファイルと紐づくノート
export interface FileNote extends BaseNote {
  type: 'file';
  filePath: string;
  fileName: string;
  originalContent: string;
}

// Union型としてのNote
export type Note = MemoryNote | FileNote;
