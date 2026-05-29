package backend

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"
)

func TestParseSHA256Hex(t *testing.T) {
	validHash := "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
	cases := []struct {
		name string
		in   string
		want string
	}{
		{"sha256sum 形式 (2スペース + ファイル名)", validHash + "  MonacoNotepad-win64-installer-1.6.0.exe", validHash},
		{"素の16進", validHash, validHash},
		{"前後に空白/改行", "\n  " + validHash + "  file.dmg \n", validHash},
		{"大文字は小文字化", "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855", validHash},
		{"63文字は不正", validHash[:63], ""},
		{"非16進を含む", "zzz0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855", ""},
		{"空", "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			if got := parseSHA256Hex(c.in); got != c.want {
				t.Errorf("parseSHA256Hex(%q) = %q, want %q", c.in, got, c.want)
			}
		})
	}
}

func TestFileSHA256(t *testing.T) {
	dir := t.TempDir()
	p := filepath.Join(dir, "blob.bin")
	content := []byte("monaco notepad update payload")
	if err := os.WriteFile(p, content, 0644); err != nil {
		t.Fatal(err)
	}

	sum := sha256.Sum256(content)
	want := hex.EncodeToString(sum[:])

	got, err := fileSHA256(p)
	if err != nil {
		t.Fatalf("fileSHA256 error: %v", err)
	}
	if got != want {
		t.Errorf("fileSHA256 = %q, want %q", got, want)
	}
}
