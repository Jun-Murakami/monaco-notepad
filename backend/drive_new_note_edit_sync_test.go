package backend

import (
	"encoding/json"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// loadCloudNote はテスト用に mock 上の Drive から特定ノートの実体を取得する。
func loadCloudNote(t *testing.T, ops *syncTestDriveOps, noteID string) *Note {
	t.Helper()
	fileID := "test-file-" + noteID + ".json"
	ops.mu.RLock()
	data, ok := ops.files[fileID]
	ops.mu.RUnlock()
	require.True(t, ok, "cloud note %s missing", noteID)
	var n Note
	require.NoError(t, json.Unmarshal(data, &n))
	return &n
}

// 「新規ノートを作成 → 直後に編集 → 別端末で内容が反映されない」バグの再現テスト。
//
// 想定シナリオ:
//  1. ユーザーが新規ノートを作る (タイトル/本文ともに空)
//  2. backend が SaveNote('create') を受けて MarkNoteDirty → push が走り
//     空のノートが Drive にアップロードされる
//  3. ユーザーが本文を打ち始める
//  4. autoSave が SaveNote('update') を発火し、再度 MarkNoteDirty → push
//  5. 2回目の push が走った時、Drive 側のノート本文は最新の "Hello, world" に
//     更新されているはず
//
// これが落ちる場合、新規ノート直後の編集が Drive に反映されない (= ユーザー報告のバグ)。
func TestSyncNotes_NewNoteContentUpdateAfterCreatePush_IsPushedToDrive(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	const initialTs = "2025-01-01T00:00:00Z"
	ops.fixedModifiedTime = initialTs
	ds.syncState.LastSyncedDriveTs = initialTs
	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	// 1) 空のノートを作成 → push
	emptyNote := &Note{ID: "new1", Title: "", Content: "", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(emptyNote))
	ds.syncState.MarkNoteDirty(emptyNote.ID)
	require.NoError(t, ds.SyncNotes())

	cloudListAfterCreate := cloudNoteListFromMock(t, ops, noteListID)
	require.Len(t, cloudListAfterCreate.Notes, 1, "create push 後は cloud noteList に 1 件入っているはず")
	assert.Equal(t, "new1", cloudListAfterCreate.Notes[0].ID)
	assert.False(t, ds.syncState.IsDirty(), "create push 完了後は dirty が落ちているはず")

	// 2) ユーザーが本文を編集 → autoSave → SaveNote('update') 相当
	updatedNote := &Note{ID: "new1", Title: "", Content: "Hello, world", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(updatedNote))
	ds.syncState.MarkNoteDirty(updatedNote.ID)
	require.NoError(t, ds.SyncNotes())

	// 3) Drive 側のノート本文が最新になっているか
	cloudNote := loadCloudNote(t, ops, "new1")
	assert.Equal(t, "Hello, world", cloudNote.Content, "2回目の push 後は Drive のノート本文が更新されているはず")
	assert.False(t, ds.syncState.IsDirty(), "2回目の push 完了後も dirty は落ちているはず")
}

// 別端末から見て「空ノートだけ届いて本文が反映されない」というユーザー報告の核心を狙う。
//
// driveService の Drive ops が production 同様に operationsQueue 経由になるよう
// rebind した上で、create push の途中 (queue 内 UpdateFile 待ち中) にユーザーの
// 1 回目の編集を流し込み、push 1 回目完了後に書き戻した LastSyncedNoteHash と
// Drive 側ノート本文が乖離しないかを確認する。
func TestSyncNotes_QueuedCreatePush_LastSyncedHashMatchesDriveContent(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	rebindDriveServiceOps(ds, ops) // production と同じく queue 経由にする

	const initialTs = "2025-01-01T00:00:00Z"
	ops.fixedModifiedTime = initialTs
	ds.syncState.LastSyncedDriveTs = initialTs
	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	// 1) 空ノートを作る
	emptyNote := &Note{ID: "n1", Title: "", Content: "", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(emptyNote))
	ds.syncState.MarkNoteDirty(emptyNote.ID)

	// 2) 1 回目の SyncNotes (create push) を別 goroutine で実行。
	//    UpdateFile (noteList) で queue debounce が走るため数秒かかる。
	pushDone := make(chan error, 1)
	go func() {
		pushDone <- ds.SyncNotes()
	}()

	// 3) push 進行中にユーザーが本文を編集 (autoSave 相当)
	time.Sleep(500 * time.Millisecond)
	updatedNote := &Note{ID: "n1", Title: "", Content: "Hello, world", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(updatedNote))
	ds.syncState.MarkNoteDirty(updatedNote.ID)

	// 4) 1 回目の push の完了を待つ
	require.NoError(t, <-pushDone)

	// 5) 1 回目 push 直後の不変条件:
	//    - LastSyncedNoteHash[id] は実際に Drive にアップロードされた内容の hash と
	//      一致していなければならない。さもないと続く push が「もう同期済み」と
	//      誤判断して新しい本文を upload しない。
	syncedHash := ds.syncState.LastSyncedNoteHash["n1"]
	driveNote := loadCloudNote(t, ops, "n1")
	driveHash := computeContentHash(driveNote)
	assert.Equal(t, driveHash, syncedHash,
		"LastSyncedNoteHash と Drive 上のノート本文の hash が一致しなければならない (これがズレると次回push で skip される)")

	// 6) ユーザー編集が dirty として残り続けて、続く push で Drive に反映される
	require.NoError(t, ds.SyncNotes())
	driveNoteFinal := loadCloudNote(t, ops, "n1")
	assert.Equal(t, "Hello, world", driveNoteFinal.Content,
		"2回目の push 完了時には Drive のノート本文が編集後の内容になっているはず")
}

// 上の sequential 版に加えて、create push と update push がレースする場合の再現。
// 仮説: 「create push 進行中に autoSave が発火し、edit が呑まれる」シナリオ。
//
// hookSyncTestDriveOps を使って、create push 内で note ファイル作成中に
// 「ユーザーがちょうど本文を打ち終えた」状況を再現する。
func TestSyncNotes_EditDuringCreatePush_IsEventuallyPushedToDrive(t *testing.T) {
	ds, ops, cleanup := newSyncTestDriveService(t)
	defer cleanup()

	hookOps := &hookSyncTestDriveOps{syncTestDriveOps: ops}
	rebindDriveServiceOps(ds, hookOps)

	const initialTs = "2025-01-01T00:00:00Z"
	hookOps.fixedModifiedTime = initialTs
	ds.syncState.LastSyncedDriveTs = initialTs
	noteListID := ds.auth.GetDriveSync().NoteListID()
	putCloudNoteList(t, ops, noteListID, &NoteList{Version: CurrentVersion, Notes: []NoteMetadata{}})

	// 空のノートを作成して MarkNoteDirty
	emptyNote := &Note{ID: "new1", Title: "", Content: "", Language: "plaintext"}
	require.NoError(t, ds.noteService.SaveNote(emptyNote))
	ds.syncState.MarkNoteDirty(emptyNote.ID)

	// create push 中、note ファイル upload のタイミングでユーザー編集が割り込む。
	var injected sync.Once
	hookOps.onCreateFile = func(name string) {
		if name != "new1.json" {
			return
		}
		injected.Do(func() {
			updated := &Note{ID: "new1", Title: "", Content: "Hello, world", Language: "plaintext"}
			require.NoError(t, ds.noteService.SaveNote(updated))
			ds.syncState.MarkNoteDirty(updated.ID)
		})
	}

	// 1回目の SyncNotes (create push) — レースで edit が混入する
	require.NoError(t, ds.SyncNotes())

	// 2回目の SyncNotes (本来 autoSave 発火後に triggerSync で走る相当)
	require.NoError(t, ds.SyncNotes())

	// Drive のノート本文が最新の内容に追いついているか
	cloudNote := loadCloudNote(t, ops, "new1")
	assert.Equal(t, "Hello, world", cloudNote.Content,
		"create push 中に行われた edit も、続く sync で Drive に反映されているはず")
	assert.False(t, ds.syncState.IsDirty(),
		"全 sync 完了後は dirty が落ちているはず")
}
