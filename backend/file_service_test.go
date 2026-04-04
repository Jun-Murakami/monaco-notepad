package backend

import (
	"testing"

	"golang.org/x/text/encoding/japanese"
)

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
