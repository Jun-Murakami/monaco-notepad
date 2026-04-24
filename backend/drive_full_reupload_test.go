package backend

import (
	"context"
	"encoding/json"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// capturingLogger は InfoCode 呼び出しを記録するテスト用ロガー。
// テストモードでは通常 InfoCode は no-op になるため、進捗メッセージを検証するために
// 既存 AppLogger をラップして保持するだけにする。
type capturingLogger struct {
	AppLogger
	mu       sync.Mutex
	infoCode []capturedInfo
}

type capturedInfo struct {
	code string
	args map[string]interface{}
}

func newCapturingLogger(t *testing.T) *capturingLogger {
	t.Helper()
	return &capturingLogger{
		AppLogger: NewAppLogger(context.Background(), true, t.TempDir()),
	}
}

func (l *capturingLogger) InfoCode(code string, args map[string]interface{}) {
	l.mu.Lock()
	l.infoCode = append(l.infoCode, capturedInfo{code: code, args: args})
	l.mu.Unlock()
}

func (l *capturingLogger) infoCalls(code string) []capturedInfo {
	l.mu.Lock()
	defer l.mu.Unlock()
	out := make([]capturedInfo, 0, len(l.infoCode))
	for _, c := range l.infoCode {
		if c.code == code {
			out = append(out, c)
		}
	}
	return out
}

// ----------------------------------------------------------------------------
// ensureNoteList / pushLocalChanges の「全ノート再アップロード」フロー統合テスト。
//
// 想定シナリオ:
//  1. DeleteAllDriveData 直後の再ログイン
//     → MarkForFullReupload により全ノートを dirty 化して FullReuploadPending を立て、
//       ensureNoteList は noteList を先行作成せず pushLocalChanges に任せる。
//  2. オフラインで作成したノートを持ったまま初回 Google サインイン
//     → SaveNote が毎回 MarkNoteDirty を呼ぶので dirty + dirtyIDs が溜まっており、
//       同様に ensureNoteList が noteList を先行作成しないで pushLocalChanges に任せる。
//
// 退行した場合の症状: Drive 側に noteList だけ存在してノート本体が無く、
// 他端末から見るとゾンビメタデータだらけの状態になる。
// ----------------------------------------------------------------------------

// TestEnsureNoteList_CreatesNoteListWhenNoPendingUploads は初回起動直後など、
// 未アップロードが無い状態では従来通り noteList を作成することを確認する（リグレッション防止）。
func TestEnsureNoteList_CreatesNoteListWhenNoPendingUploads(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	// noteList が Drive に存在しない状態を作る: noteListID を空、Drive mock ファイルも空のまま
	ds.auth.GetDriveSync().SetNoteListID("")

	// dirty / DirtyNoteIDs / FullReuploadPending すべて false の初期状態
	require.False(t, ds.syncState.HasPendingUploads())

	err := ds.ensureNoteList()
	require.NoError(t, err)

	// noteList が Drive に作られているはず
	createdID := ds.auth.GetDriveSync().NoteListID()
	assert.NotEmpty(t, createdID, "pending uploads 無しなら ensureNoteList が Drive noteList を作る")

	ops.mu.RLock()
	_, exists := ops.files[createdID]
	ops.mu.RUnlock()
	assert.True(t, exists)
}

// TestEnsureNoteList_SkipsWhenFullReuploadPending は DeleteAllDriveData 相当のシナリオで
// ensureNoteList が noteList を作らないことを確認する。
func TestEnsureNoteList_SkipsWhenFullReuploadPending(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	ds.auth.GetDriveSync().SetNoteListID("")
	ds.syncState.MarkForFullReupload([]string{"note1", "note2"})

	err := ds.ensureNoteList()
	require.NoError(t, err)

	assert.Empty(t, ds.auth.GetDriveSync().NoteListID(),
		"FullReuploadPending なら noteList を作らずに pushLocalChanges に任せる")

	ops.mu.RLock()
	for fileID := range ops.files {
		// 事前状態は空なので何もファイルが増えていない事を確認する
		assert.NotContains(t, strings.ToLower(fileID), "notelist_v2", "noteList は作られない")
	}
	ops.mu.RUnlock()
}

// TestEnsureNoteList_SkipsWhenOfflineFirstDirty はオフラインで作ったノートを持って
// 初サインインしたシナリオで ensureNoteList が noteList を作らない事を確認する。
func TestEnsureNoteList_SkipsWhenOfflineFirstDirty(t *testing.T) {
	ds, _, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	// オフラインで 2 ノート作成した状態を再現: SaveNote 相当 + MarkNoteDirty
	require.NoError(t, ds.noteService.SaveNote(&Note{
		ID: "n1", Title: "n1", Content: "offline1", Language: "plaintext",
	}))
	require.NoError(t, ds.noteService.SaveNote(&Note{
		ID: "n2", Title: "n2", Content: "offline2", Language: "plaintext",
	}))
	ds.syncState.MarkNoteDirty("n1")
	ds.syncState.MarkNoteDirty("n2")

	ds.auth.GetDriveSync().SetNoteListID("")

	err := ds.ensureNoteList()
	require.NoError(t, err)

	assert.Empty(t, ds.auth.GetDriveSync().NoteListID(),
		"dirty + dirtyIDs があるなら ensureNoteList は noteList を作らず push に任せる")
}

// TestSyncNotes_FullReupload_OfflineFirst_UploadsAllNotesThenCreatesNoteList は
// オフラインファーストのフルフロー(ensureNoteList → SyncNotes → pushLocalChanges)で
// 個別ノート本体が Drive に上がってから noteList が作られる事を検証する。
func TestSyncNotes_FullReupload_OfflineFirst_UploadsAllNotesThenCreatesNoteList(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	notes := []*Note{
		{ID: "n1", Title: "n1", Content: "offline1", Language: "plaintext"},
		{ID: "n2", Title: "n2", Content: "offline2", Language: "plaintext"},
		{ID: "n3", Title: "n3", Content: "offline3", Language: "plaintext"},
	}
	for _, n := range notes {
		require.NoError(t, ds.noteService.SaveNote(n))
		ds.syncState.MarkNoteDirty(n.ID)
	}

	ds.auth.GetDriveSync().SetNoteListID("")

	require.NoError(t, ds.ensureNoteList())
	assert.Empty(t, ds.auth.GetDriveSync().NoteListID(), "この時点ではまだ noteList を作らない")

	require.NoError(t, ds.SyncNotes())

	// 各ノート本体が Drive にある
	ops.mu.RLock()
	for _, n := range notes {
		_, exists := ops.files["test-file-"+n.ID+".json"]
		assert.True(t, exists, "pushLocalChanges で個別ノート本体が上がっている必要がある: %s", n.ID)
	}
	// noteList も作られている
	_, noteListExists := ops.files["test-file-noteList_v2.json"]
	ops.mu.RUnlock()
	assert.True(t, noteListExists, "ノート本体 upload の後で noteList が作られる")

	// dirty フラグはクリアされている
	assert.False(t, ds.syncState.IsDirty())
}

// TestSyncNotes_FullReupload_AfterDeleteAllDriveData は MarkForFullReupload 経由で
// 「Drive は空、ローカルはまっさらな dirty=false 状態、flag だけが強制的に立っている」
// という DeleteAllDriveData 直後のシナリオを模擬する。flag が立っていれば再アップが走り、
// 完了時に ClearFullReupload されて flag が落ちる事を確認する。
func TestSyncNotes_FullReupload_AfterDeleteAllDriveData(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	// Drive 削除前の「既に同期済み」状態を作る
	notes := []*Note{
		{ID: "n1", Title: "n1", Content: "before-delete 1", Language: "plaintext"},
		{ID: "n2", Title: "n2", Content: "before-delete 2", Language: "plaintext"},
	}
	noteIDs := make([]string, 0, len(notes))
	for _, n := range notes {
		require.NoError(t, ds.noteService.SaveNote(n))
		noteIDs = append(noteIDs, n.ID)
	}

	// 「DeleteAllDriveData 相当」: 全ノートを再アップ対象にフラグ化
	ds.syncState.MarkForFullReupload(noteIDs)
	ds.auth.GetDriveSync().SetNoteListID("")

	require.True(t, ds.syncState.IsFullReuploadPending())

	require.NoError(t, ds.ensureNoteList())
	assert.Empty(t, ds.auth.GetDriveSync().NoteListID())

	require.NoError(t, ds.SyncNotes())

	// 全ノート本体 + noteList が Drive にある
	ops.mu.RLock()
	_, n1Exists := ops.files["test-file-n1.json"]
	_, n2Exists := ops.files["test-file-n2.json"]
	_, noteListExists := ops.files["test-file-noteList_v2.json"]
	ops.mu.RUnlock()
	assert.True(t, n1Exists)
	assert.True(t, n2Exists)
	assert.True(t, noteListExists)

	// flag がクリアされて通常同期に復帰している
	assert.False(t, ds.syncState.IsFullReuploadPending(),
		"pushLocalChanges 完了時に FullReuploadPending は落ちる")
	assert.False(t, ds.syncState.IsDirty())
}

// TestSyncNotes_FullReupload_ResumeSkipsAlreadyUploaded は、アプリを途中で終了した
// シナリオで既に Drive に上げ終わっているノートを CreateNote せずにスキップして
// 残りだけ続ける事を検証する（UpdateSyncedNoteHash の永続化を利用した resume）。
func TestSyncNotes_FullReupload_ResumeSkipsAlreadyUploaded(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	// 3 ノートをローカル作成 + 全て dirty にする
	notes := []*Note{
		{ID: "n1", Title: "n1", Content: "content1", Language: "plaintext"},
		{ID: "n2", Title: "n2", Content: "content2", Language: "plaintext"},
		{ID: "n3", Title: "n3", Content: "content3", Language: "plaintext"},
	}
	for _, n := range notes {
		require.NoError(t, ds.noteService.SaveNote(n))
		ds.syncState.MarkNoteDirty(n.ID)
	}

	// 「前回の session で n1, n2 は既に Drive に上げ終わった」状態を作る:
	// UpdateSyncedNoteHash で個別 hash を永続化しつつ Drive ファイルも事前配置する
	n1Loaded, err := ds.noteService.LoadNote("n1")
	require.NoError(t, err)
	n2Loaded, err := ds.noteService.LoadNote("n2")
	require.NoError(t, err)
	n1Hash := computeContentHash(n1Loaded)
	n2Hash := computeContentHash(n2Loaded)
	ds.syncState.UpdateSyncedNoteHash("n1", n1Hash)
	ds.syncState.UpdateSyncedNoteHash("n2", n2Hash)
	putCloudNote(t, ops, n1Loaded)
	putCloudNote(t, ops, n2Loaded)

	// CreateFile 呼び出しを記録するフックを仕込む（n3 だけ呼ばれるはず）
	hookOps := &hookSyncTestDriveOps{syncTestDriveOps: ops}
	var createdFileNames []string
	hookOps.onCreateFile = func(name string) {
		createdFileNames = append(createdFileNames, name)
	}
	rebindDriveServiceOps(ds, hookOps)

	// noteList を先行作成しない状態（実際の resume では ensureNoteList が skip する）
	ds.auth.GetDriveSync().SetNoteListID("")

	require.NoError(t, ds.SyncNotes())

	// n3 だけ新規作成されている事を確認
	var noteFileCreates []string
	for _, name := range createdFileNames {
		if strings.HasSuffix(name, ".json") && name != "noteList_v2.json" {
			noteFileCreates = append(noteFileCreates, name)
		}
	}
	assert.Equal(t, []string{"n3.json"}, noteFileCreates,
		"既にアップ済みの n1, n2 はスキップされ、n3 だけが新規作成される")

	// 最終的に全ノート + noteList が Drive にある
	ops.mu.RLock()
	_, n1OnDrive := ops.files["test-file-n1.json"]
	_, n2OnDrive := ops.files["test-file-n2.json"]
	_, n3OnDrive := ops.files["test-file-n3.json"]
	_, noteListOnDrive := ops.files["test-file-noteList_v2.json"]
	ops.mu.RUnlock()
	assert.True(t, n1OnDrive)
	assert.True(t, n2OnDrive)
	assert.True(t, n3OnDrive)
	assert.True(t, noteListOnDrive)
	assert.False(t, ds.syncState.IsDirty())
}

// TestSyncNotes_FullReupload_ResumeCounter_ContiguousAndRebased は、再起動後の
// 進捗メッセージが「ジャンプなし」かつ「残り件数を新しい母数として 1..M」で表示される事を検証。
// UX の要: 60 件中 30 件既済 + 30 件残りなら、1/30, 2/30, ..., 30/30 と出る事。
func TestSyncNotes_FullReupload_ResumeCounter_ContiguousAndRebased(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	logger := newCapturingLogger(t)
	ds.logger = logger
	ds.driveSync = NewDriveSyncService(ds.driveOps, "test-folder", "test-root", logger)

	// 5 件ローカル、うち 3 件を「前回上げ終えた」状態にする
	notes := []*Note{
		{ID: "n1", Title: "n1", Content: "c1", Language: "plaintext"},
		{ID: "n2", Title: "n2", Content: "c2", Language: "plaintext"},
		{ID: "n3", Title: "n3", Content: "c3", Language: "plaintext"},
		{ID: "n4", Title: "n4", Content: "c4", Language: "plaintext"},
		{ID: "n5", Title: "n5", Content: "c5", Language: "plaintext"},
	}
	for _, n := range notes {
		require.NoError(t, ds.noteService.SaveNote(n))
		ds.syncState.MarkNoteDirty(n.ID)
	}

	// n1, n3, n5 は既に Drive に上げた体でマーク
	for _, id := range []string{"n1", "n3", "n5"} {
		n, err := ds.noteService.LoadNote(id)
		require.NoError(t, err)
		ds.syncState.UpdateSyncedNoteHash(id, computeContentHash(n))
		putCloudNote(t, ops, n)
	}

	ds.auth.GetDriveSync().SetNoteListID("")

	require.NoError(t, ds.SyncNotes())

	// 残り 2 件だけが upload 対象 → 1/2, 2/2 で emit されるはず
	uploadMessages := logger.infoCalls(MsgDriveSyncUploadNote)
	require.Len(t, uploadMessages, 2, "残り 2 件分だけ message 発火")

	totals := make([]int, 0, 2)
	currents := make([]int, 0, 2)
	noteIds := make([]string, 0, 2)
	for _, m := range uploadMessages {
		totals = append(totals, m.args["total"].(int))
		currents = append(currents, m.args["current"].(int))
		noteIds = append(noteIds, m.args["noteId"].(string))
	}

	// total は全メッセージで 2 (残件数に rebase されている、元の 5 ではない)
	assert.Equal(t, []int{2, 2}, totals, "total は残件数 (rebase) で固定")

	// current は 1, 2 の連番 (順序依存なし、map イテレーション順のどちらでも連番になる)
	assert.Equal(t, []int{1, 2}, currents, "1/M, 2/M で連番、ジャンプなし")

	// upload されたのは n2 と n4 のどちらかだけ (n1/n3/n5 は skip)
	for _, id := range noteIds {
		assert.Contains(t, []string{"n2", "n4"}, id)
	}
	assert.ElementsMatch(t, []string{"n2", "n4"}, noteIds)
}

// TestSyncNotes_FullReupload_InitialCounter_UsesActualUploadCount は初回 (resume
// なし) の場合も total は "実際に Drive へ上げる件数" = dirty 全件になる事を確認。
func TestSyncNotes_FullReupload_InitialCounter_UsesActualUploadCount(t *testing.T) {
	ds, _, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	logger := newCapturingLogger(t)
	ds.logger = logger
	ds.driveSync = NewDriveSyncService(ds.driveOps, "test-folder", "test-root", logger)

	for _, id := range []string{"n1", "n2", "n3"} {
		require.NoError(t, ds.noteService.SaveNote(&Note{
			ID: id, Title: id, Content: id, Language: "plaintext",
		}))
		ds.syncState.MarkNoteDirty(id)
	}
	ds.auth.GetDriveSync().SetNoteListID("")

	require.NoError(t, ds.SyncNotes())

	uploadMessages := logger.infoCalls(MsgDriveSyncUploadNote)
	require.Len(t, uploadMessages, 3)

	for _, m := range uploadMessages {
		assert.Equal(t, 3, m.args["total"], "初回は total=dirty 全件")
	}

	// current は 1..3 の順列 (map 順次第)
	currents := []int{}
	for _, m := range uploadMessages {
		currents = append(currents, m.args["current"].(int))
	}
	assert.ElementsMatch(t, []int{1, 2, 3}, currents)
}

// TestSyncNotes_FullReupload_ResumeReuploadsIfEdited は、resume 時にユーザーが
// 該当ノートを編集していた場合（hash が変わっている）は正しく再アップロードする事を検証する。
func TestSyncNotes_FullReupload_ResumeReuploadsIfEdited(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	// 「前回 session で n1 v1 を上げ終えた」状態を再現
	n1v1 := &Note{ID: "n1", Title: "n1", Content: "v1", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(n1v1))
	loadedV1, err := ds.noteService.LoadNote("n1")
	require.NoError(t, err)
	oldHash := computeContentHash(loadedV1)
	ds.syncState.UpdateSyncedNoteHash("n1", oldHash)
	putCloudNote(t, ops, loadedV1)

	// crash と restart の間にユーザーが n1 を編集
	n1v2 := &Note{ID: "n1", Title: "n1", Content: "v2 edited during downtime", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(n1v2))
	ds.syncState.MarkNoteDirty("n1")

	ds.auth.GetDriveSync().SetNoteListID("")

	require.NoError(t, ds.SyncNotes())

	// Drive 側の n1 ファイル内容が v2 に更新されている
	ops.mu.RLock()
	cloudFile, exists := ops.files["test-file-n1.json"]
	ops.mu.RUnlock()
	require.True(t, exists)

	var cloudNote Note
	require.NoError(t, json.Unmarshal(cloudFile, &cloudNote))
	assert.Equal(t, "v2 edited during downtime", cloudNote.Content,
		"hash が一致しない（ユーザー編集あり）なら再アップロードされて最新版が Drive に反映")
}

// TestSyncNotes_FullReupload_ResumesAfterRestart はアプリを再アップロード途中で
// 終了した状態から再起動した場合、FullReuploadPending が永続化されており、
// 再度の ensureNoteList + SyncNotes で残りがアップロードされる事を確認する。
func TestSyncNotes_FullReupload_ResumesAfterRestart(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	notes := []*Note{
		{ID: "n1", Title: "n1", Content: "content1", Language: "plaintext"},
		{ID: "n2", Title: "n2", Content: "content2", Language: "plaintext"},
	}
	for _, n := range notes {
		require.NoError(t, ds.noteService.SaveNote(n))
	}
	ds.syncState.MarkForFullReupload([]string{"n1", "n2"})

	// 再アップロード途中で終了 → sync_state.json に flag + dirtyIDs が書かれているはず
	// 新しい SyncState を同じディレクトリから Load して再起動を模擬
	reloaded := NewSyncState(ds.appDataDir)
	require.NoError(t, reloaded.Load())
	require.True(t, reloaded.IsFullReuploadPending(),
		"再起動後も FullReuploadPending が残っている")
	require.True(t, reloaded.DirtyNoteIDs["n1"])
	require.True(t, reloaded.DirtyNoteIDs["n2"])

	// driveService 側にも Load 済み SyncState を注入して再開相当
	ds.syncState = reloaded
	ds.auth.GetDriveSync().SetNoteListID("")

	require.NoError(t, ds.ensureNoteList())
	require.NoError(t, ds.SyncNotes())

	ops.mu.RLock()
	_, n1Exists := ops.files["test-file-n1.json"]
	_, n2Exists := ops.files["test-file-n2.json"]
	_, noteListExists := ops.files["test-file-noteList_v2.json"]
	ops.mu.RUnlock()
	assert.True(t, n1Exists)
	assert.True(t, n2Exists)
	assert.True(t, noteListExists)
	assert.False(t, ds.syncState.IsFullReuploadPending())
}
