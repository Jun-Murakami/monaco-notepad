// 型定義
export type Note = {
	id: string;
	title: string;
	content: string | null; // コンテンツはオプショナル
	contentHeader: string | null; // アーカイブ時のコンテンツヘッダー
	language: string;
	modifiedTime: string;
	archived: boolean;
};

// ノートのメタデータを管理するための型
export type NoteMetadata = {
	id: string;
	title: string;
	contentHeader: string | null; // アーカイブ時のコンテンツヘッダー
	language: string;
	modifiedTime: string;
	archived: boolean;
};

// ノートリストの型
export type NoteList = {
	version: string; // 将来の互換性のため
	notes: NoteMetadata[];
	lastSync: string; // 最後の同期時刻
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
	wordWrap: string;
	minimap: boolean;
	windowWidth: number;
	windowHeight: number;
	windowX: number;
	windowY: number;
	isMaximized: boolean;
	isDebug: boolean;
};

// デフォルトの設定
export const DEFAULT_EDITOR_SETTINGS: Partial<Settings> = {
	fontFamily: 'Consolas, Monaco, "Courier New", monospace',
	fontSize: 14,
	isDarkMode: false,
	wordWrap: 'off',
	minimap: true,
	isDebug: false,
};
