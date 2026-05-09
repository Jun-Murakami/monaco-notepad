package backend

import (
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/text/encoding/japanese"
)

// fileServiceTest は context への依存を持たないテスト用ヘルパ。
// SelectFile / SelectSaveFileUri はダイアログを呼ぶため触らない。
func newFileServiceForTest() *fileService {
	return &fileService{ctx: nil}
}

// 「保存直後に外部編集ダイアログが誤表示される」バグの再現テスト群。
//
// バグの根本原因:
//   - フロントエンド (useFileOperations.handleSaveFile) は SaveFile 完了後に
//     `new Date().toISOString()` (= JS の wall clock) を modifiedTime として保存する。
//   - ディスク上の mtime は kernel が write 中に記録するナノ秒精度値。
//   - NTFS 等で「ディスク mtime > JS now」になるケースが起こり、
//     CheckFileModified が true を返してしまう (= 誤検知)。
//
// 修正後の SaveFile は (string, error) で実際のディスク mtime を RFC3339Nano で
// 返し、フロントエンドはそれをそのまま modifiedTime として使う。

func TestSaveFile_ReturnsDiskModifiedTime(t *testing.T) {
	fs := newFileServiceForTest()
	dir := t.TempDir()
	path := filepath.Join(dir, "save-roundtrip.txt")

	mtime, err := fs.SaveFile(path, "hello world")
	if err != nil {
		t.Fatalf("SaveFile returned error: %v", err)
	}
	if mtime == "" {
		t.Fatalf("SaveFile returned empty mtime; expected RFC3339Nano formatted disk mtime")
	}

	// パースできて、ディスクの実 mtime と完全一致すること。
	parsed, err := time.Parse(time.RFC3339Nano, mtime)
	if err != nil {
		t.Fatalf("SaveFile mtime is not valid RFC3339Nano: %q (%v)", mtime, err)
	}
	info, err := os.Stat(path)
	if err != nil {
		t.Fatalf("os.Stat failed: %v", err)
	}
	if !parsed.Equal(info.ModTime()) {
		t.Fatalf("SaveFile mtime mismatches disk mtime\n  returned: %s\n  disk:     %s",
			parsed.Format(time.RFC3339Nano), info.ModTime().Format(time.RFC3339Nano))
	}
}

func TestCheckFileModified_NoFalsePositiveAfterSave(t *testing.T) {
	fs := newFileServiceForTest()
	dir := t.TempDir()
	path := filepath.Join(dir, "no-false-positive.txt")

	mtime, err := fs.SaveFile(path, "initial")
	if err != nil {
		t.Fatalf("SaveFile returned error: %v", err)
	}

	// 「保存直後 → ウィンドウフォーカスが戻る」シナリオ。
	// 保存後の mtime をそのまま CheckFileModified に渡すと、ファイル変更は無いので
	// false が返るはず。ナノ秒精度のずれが原因で誤検知してはならない。
	modified, err := fs.CheckFileModified(path, mtime)
	if err != nil {
		t.Fatalf("CheckFileModified returned error: %v", err)
	}
	if modified {
		t.Fatalf("CheckFileModified returned true immediately after SaveFile (false positive)")
	}
}

// 旧フロントエンドが渡していた「ミリ秒精度の JS 時刻」相当の値で誤検知する
// パターンを再現する回帰テスト。`time.Now()` を「保存直後にフロントが取った時刻」と
// 見立てて切り捨てた文字列を渡したとき、ナノ秒精度のディスク mtime > 切り捨て値
// になることがあり、CheckFileModified が true を返す可能性がある。
//
// このテストはバグそのものを直接観察するというより、「SaveFile が返す mtime を
// 信頼するように直したフローでは絶対に誤検知が起きないこと」を保証する。
func TestCheckFileModified_FrontendSavedMtimeNeverFalsePositive(t *testing.T) {
	fs := newFileServiceForTest()
	dir := t.TempDir()
	path := filepath.Join(dir, "frontend-mtime.txt")

	// 100 回保存して、毎回 SaveFile が返した mtime で CheckFileModified を呼ぶ。
	// SaveFile が disk mtime をそのまま返している限り、ナノ秒のドリフトは
	// 起きないはずなので 100 回中 0 件の false positive を期待する。
	for i := 0; i < 100; i++ {
		mtime, err := fs.SaveFile(path, "content")
		if err != nil {
			t.Fatalf("SaveFile returned error: %v", err)
		}
		modified, err := fs.CheckFileModified(path, mtime)
		if err != nil {
			t.Fatalf("CheckFileModified returned error: %v", err)
		}
		if modified {
			t.Fatalf("iter %d: CheckFileModified returned true after SaveFile (false positive)", i)
		}
	}
}

func TestCheckFileModified_DetectsRealExternalEdit(t *testing.T) {
	fs := newFileServiceForTest()
	dir := t.TempDir()
	path := filepath.Join(dir, "real-edit.txt")

	mtime, err := fs.SaveFile(path, "v1")
	if err != nil {
		t.Fatalf("SaveFile returned error: %v", err)
	}

	// 1 秒後に「外部から」上書き。HFS+ の 1 秒精度を超えるので確実に差が出る。
	time.Sleep(1100 * time.Millisecond)
	if err := os.WriteFile(path, []byte("v2"), 0644); err != nil {
		t.Fatalf("external write failed: %v", err)
	}

	modified, err := fs.CheckFileModified(path, mtime)
	if err != nil {
		t.Fatalf("CheckFileModified returned error: %v", err)
	}
	if !modified {
		t.Fatalf("CheckFileModified should detect a real external edit")
	}
}

func TestDetectAndConvertEncoding(t *testing.T) {
	tests := []struct {
		name             string
		input            []byte
		wantContent      string
		wantEncoding     string
		wantEncodingBool bool // true if sourceEncoding should be non-empty
	}{
		{
			name:         "UTF-8テキストはそのまま返す",
			input:        []byte("Hello, World!"),
			wantContent:  "Hello, World!",
			wantEncoding: "",
		},
		{
			name:         "UTF-8日本語テキストはそのまま返す",
			input:        []byte("こんにちは世界"),
			wantContent:  "こんにちは世界",
			wantEncoding: "",
		},
		{
			name:         "空のファイルはUTF-8として扱う",
			input:        []byte{},
			wantContent:  "",
			wantEncoding: "",
		},
		{
			name:         "UTF-8 BOMは除去される",
			input:        append([]byte{0xEF, 0xBB, 0xBF}, []byte("Hello")...),
			wantContent:  "Hello",
			wantEncoding: "",
		},
		{
			name:         "UTF-8 BOM付き日本語テキスト",
			input:        append([]byte{0xEF, 0xBB, 0xBF}, []byte("テスト")...),
			wantContent:  "テスト",
			wantEncoding: "",
		},
		{
			name:         "ASCII文字のみはUTF-8として扱う",
			input:        []byte("plain ascii text\nwith newlines\r\n"),
			wantContent:  "plain ascii text\nwith newlines\r\n",
			wantEncoding: "",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			content, encoding := detectAndConvertEncoding(tt.input)
			if content != tt.wantContent {
				t.Errorf("content: got %q, want %q", content, tt.wantContent)
			}
			if encoding != tt.wantEncoding {
				t.Errorf("encoding: got %q, want %q", encoding, tt.wantEncoding)
			}
		})
	}
}

func TestDetectAndConvertEncoding_ShiftJIS(t *testing.T) {
	// ShiftJIS でエンコードされたテスト文字列を生成
	encoder := japanese.ShiftJIS.NewEncoder()

	tests := []struct {
		name        string
		original    string
		wantContent string
	}{
		{
			name:        "ShiftJIS日本語テキストをUTF-8に変換",
			original:    "こんにちは世界",
			wantContent: "こんにちは世界",
		},
		{
			name:        "ShiftJIS CSV形式テキスト",
			original:    "名前,年齢,住所\n田中太郎,30,東京都\n鈴木花子,25,大阪府",
			wantContent: "名前,年齢,住所\n田中太郎,30,東京都\n鈴木花子,25,大阪府",
		},
		{
			name:        "ShiftJIS半角カナ混在テキスト",
			original:    "ﾃｽﾄテスト",
			wantContent: "ﾃｽﾄテスト",
		},
		{
			name:        "ShiftJIS機種依存文字（丸数字・髙﨑など）",
			original:    "①②③㈱㈲",
			wantContent: "①②③㈱㈲",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			// UTF-8テキストをShiftJISにエンコード
			sjisBytes, err := encoder.Bytes([]byte(tt.original))
			if err != nil {
				t.Fatalf("failed to encode to ShiftJIS: %v", err)
			}

			content, encoding := detectAndConvertEncoding(sjisBytes)
			if encoding != "Shift_JIS" {
				t.Errorf("encoding: got %q, want %q", encoding, "Shift_JIS")
			}
			if content != tt.wantContent {
				t.Errorf("content: got %q, want %q", content, tt.wantContent)
			}
		})
	}
}

func TestBuildSaveDialogDefaults(t *testing.T) {
	tests := []struct {
		name             string
		fileName         string
		extension        string
		wantDefaultName  string
		wantFilterPatter string
	}{
		{
			name:             "タイトル空 + 拡張子ありは untitled を補完",
			fileName:         "",
			extension:        "txt",
			wantDefaultName:  "untitled.txt",
			wantFilterPatter: "*.txt",
		},
		{
			name:             "タイトル空白 + 拡張子ありは untitled を補完",
			fileName:         "   ",
			extension:        "txt",
			wantDefaultName:  "untitled.txt",
			wantFilterPatter: "*.txt",
		},
		{
			name:             "タイトルあり + 拡張子ありは末尾に拡張子を追加",
			fileName:         "memo",
			extension:        "txt",
			wantDefaultName:  "memo.txt",
			wantFilterPatter: "*.txt",
		},
		{
			name:             "すでに同じ拡張子が付いている場合は重複しない",
			fileName:         "memo.txt",
			extension:        "txt",
			wantDefaultName:  "memo.txt",
			wantFilterPatter: "*.txt",
		},
		{
			name:             "拡張子は大文字小文字を区別せず重複判定する",
			fileName:         "memo.TXT",
			extension:        "txt",
			wantDefaultName:  "memo.TXT",
			wantFilterPatter: "*.txt",
		},
		{
			name:             "拡張子なし + タイトル空は untitled",
			fileName:         "",
			extension:        "",
			wantDefaultName:  "untitled",
			wantFilterPatter: "*.*",
		},
		{
			name:             "拡張子なし + タイトルありはそのまま",
			fileName:         "memo",
			extension:        "",
			wantDefaultName:  "memo",
			wantFilterPatter: "*.*",
		},
		{
			name:             "先頭ドットの拡張子指定も受け入れる",
			fileName:         "memo",
			extension:        ".md",
			wantDefaultName:  "memo.md",
			wantFilterPatter: "*.md",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			gotName, gotPattern := buildSaveDialogDefaults(tt.fileName, tt.extension)
			if gotName != tt.wantDefaultName {
				t.Fatalf("default filename: got %q, want %q", gotName, tt.wantDefaultName)
			}
			if gotPattern != tt.wantFilterPatter {
				t.Fatalf("pattern: got %q, want %q", gotPattern, tt.wantFilterPatter)
			}
		})
	}
}
