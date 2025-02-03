// 型定義
export type Note = {
  id: string;
  title: string;
  content: string | null;  // コンテンツはオプショナル
  contentHeader: string | null;  // アーカイブ時のコンテンツヘッダー
  language: string;
  modifiedTime: string;
  archived: boolean;
}

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
}

export type EditorSettings = {
  fontFamily: string;
  fontSize: number;
  isDarkMode: boolean;
  wordWrap: 'on' | 'off';
  minimap: boolean;
};