/*
note_service_pathtraversal_test.go

同期データ由来の改竄されたノートIDによるパストラバーサル防御を検証する。
Drive 経由で同期されるノートの ID は別デバイスや侵害された Drive アカウントから
改竄されうるため、ファイルパス生成前に isSafeNoteID で必ず弾く必要がある。
*/

package backend

import (
	"os"
	"path/filepath"
	"runtime"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// TestIsSafeNoteID は ID 検証ロジックの境界を確認する
func TestIsSafeNoteID(t *testing.T) {
	// 正当な ID（UUID v4 / 旧来のタイムスタンプ等）は許可される
	valid := []string{
		"550e8400-e29b-41d4-a716-446655440000",
		"abc_DEF-123",
		"1700000000000",
	}
	for _, id := range valid {
		assert.Truef(t, isSafeNoteID(id), "正当なIDが弾かれた: %q", id)
	}

	// パストラバーサル・区切り文字・空・特殊値は拒否される
	invalid := []string{
		"",
		".",
		"..",
		"../evil",
		"..\\evil",
		"foo/bar",
		"foo\\bar",
		"../../settings",
		"..\\..\\..\\token",
		"a/../../b",
		"with\x00null",
	}
	for _, id := range invalid {
		assert.Falsef(t, isSafeNoteID(id), "危険なIDが許可された: %q", id)
	}
}

// TestSaveNoteFromSyncRejectsTraversal は同期保存パスがディレクトリ外への
// 書き込みを拒否することを確認する（任意ファイル上書きの防止）。
func TestSaveNoteFromSyncRejectsTraversal(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// notesDir の外（親ディレクトリ）に書き込もうとする改竄ノート
	evilID := "../evil_overwrite"
	note := &Note{
		ID:       evilID,
		Title:    "evil",
		Content:  "pwned",
		Language: "plaintext",
	}

	err := helper.noteService.SaveNoteFromSync(note)
	require.Error(t, err, "危険なIDの同期保存はエラーになるべき")

	// notesDir の外にファイルが作られていないことを確認
	escaped := filepath.Join(helper.notesDir, "..", "evil_overwrite.json")
	_, statErr := os.Stat(escaped)
	assert.True(t, os.IsNotExist(statErr), "ディレクトリ外にファイルが作成されてしまった: %s", escaped)
}

// TestDeleteNoteFromSyncRejectsTraversal は同期削除パスがディレクトリ外の
// ファイル削除を拒否することを確認する（任意ファイル削除の防止）。
func TestDeleteNoteFromSyncRejectsTraversal(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// notesDir の外に「消されては困る」ファイルを用意
	victim := filepath.Join(helper.tempDir, "victim.json")
	require.NoError(t, os.WriteFile(victim, []byte("important"), 0644))

	// notesDir からの相対で victim を指す改竄ID
	err := helper.noteService.DeleteNoteFromSync("../victim")
	require.Error(t, err, "危険なIDの同期削除はエラーになるべき")

	// victim が残っていることを確認
	_, statErr := os.Stat(victim)
	assert.NoError(t, statErr, "ディレクトリ外のファイルが削除されてしまった")
}

// TestEscapeDriveQueryValue は Drive クエリインジェクション対策のエスケープを確認する
func TestEscapeDriveQueryValue(t *testing.T) {
	// シングルクォートで quote-break を狙う値
	got := escapeDriveQueryValue("x' or name!='")
	assert.Equal(t, `x\' or name!=\'`, got)

	// バックスラッシュもエスケープされる
	assert.Equal(t, `a\\b`, escapeDriveQueryValue(`a\b`))

	// 通常のファイル名は変化しない
	normal := "550e8400-e29b-41d4-a716-446655440000.json"
	assert.Equal(t, normal, escapeDriveQueryValue(normal))
}

func TestPathTraversalPlatformNote(t *testing.T) {
	// Windows ではバックスラッシュも区切り文字。両プラットフォームで弾けることを明示。
	if runtime.GOOS == "windows" {
		assert.False(t, isSafeNoteID(`..\..\token`))
	}
	assert.False(t, isSafeNoteID("../../token"))
}
