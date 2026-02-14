package backend

import "testing"

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
