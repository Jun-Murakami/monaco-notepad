package backend

import (
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// 端末間シナリオテスト（デスクトップ × モバイル形式のピア）。
//
// ピアは「プロトコル通りに正しく振る舞う別端末」。ここで落ちるテストは、
// 相手が正しくてもデスクトップ側の同期がデータを壊す / 変更を取りこぼすことを意味する。
// ユーザー報告の 3 症状をそれぞれ再現する:
//   ① モバイルの変更がデスクトップに反映されない
//   ② 最新のノートがリストの下に来る
//   ③ 他方の端末で「不明ノート」に入る

type scenario struct {
	t    *testing.T
	fd   *fakeDrive
	peer *mobilePeer
	desk *desktopDevice
}

func newScenario(t *testing.T) *scenario {
	t.Helper()
	fd := newFakeDrive(t)
	peer := newMobilePeer(t, fd)
	peer.ensureLayout()
	return &scenario{t: t, fd: fd, peer: peer, desk: newDesktopDevice(t, fd, "desktop")}
}

func (s *scenario) note(id, content string) peerNote {
	return peerNote{ID: id, Title: "Title " + id, Content: content, Language: "markdown", ModifiedTime: s.fd.Now()}
}

// seedShared はピアで A, B を作り（表示順 [B, A]）、デスクトップが起動して同期済みの状態にする。
func (s *scenario) seedShared() {
	s.t.Helper()
	s.peer.saveNote(s.note("A", "a1"), "")
	s.peer.saveNote(s.note("B", "b1"), "")
	s.desk.startup()
	require.Equal(s.t, []string{"B", "A"}, s.desk.topLevelNoteIDs())
}

func isDesktop(r fakeRequest) bool { return r.Device == "desktop" }

// ---- ① 変更の取りこぼし / 上書き ----

func TestScenario_DesktopPushDoesNotDropPeerNoteAddedConcurrently(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.editNote("A", "edited on desktop")

	// デスクトップが noteList をアップロードする直前に、ピアが新規ノートを追加する
	s.fd.BeforeRequest(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.update" && r.FileName == "noteList_v2.json"
	}, func(fakeRequest) {
		s.peer.saveNote(s.note("P", "from mobile"), "")
	})
	s.desk.sync()

	assert.Contains(t, s.peer.cloudNoteIDs(), "P", "クラウド noteList からピアのノートが消えた")
	s.desk.sync()
	assert.Contains(t, s.desk.noteIDs(), "P")
}

func TestScenario_PeerChangeRightAfterDesktopUploadIsPulledByNextSync(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.editNote("A", "edited on desktop")

	// デスクトップの noteList アップロードが完了した直後にピアが書き込む
	s.fd.AfterRequest(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.update" && r.FileName == "noteList_v2.json"
	}, func(fakeRequest) {
		s.peer.saveNote(s.note("P", "from mobile"), "")
	})
	s.desk.sync()
	s.desk.sync()

	assert.Contains(t, s.desk.noteIDs(), "P", "ピアの変更を同期済みと誤認して取り込まない")
}

func TestScenario_PeerChangeRightAfterDesktopUploadIsDetectedByPolling(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.editNote("A", "edited on desktop")

	// デスクトップの noteList アップロードが完了した直後（自分の書き込みの後処理の最中）にピアが書き込む。
	// 旧実装は自分の書き込み後に Changes トークンを「現在」へ取り直していたため、この変更を見逃した。
	s.fd.AfterRequest(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.update" && r.FileName == "noteList_v2.json"
	}, func(fakeRequest) {
		s.peer.saveNote(s.note("P", "from mobile"), "")
	})
	s.desk.sync()
	s.desk.pollOnce()

	assert.Contains(t, s.desk.noteIDs(), "P", "ポーリングがピアの変更を検知しない")
}

func TestScenario_TransientDownloadFailureIsRetriedOnNextSync(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.peer.saveNote(s.note("B", "b2 edited on mobile"), "")

	s.fd.FailWhen(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.download" && r.FileName == "B.json"
	}, 500, 1)
	s.desk.sync()
	s.desk.sync()

	b, err := s.desk.readNote("B")
	require.NoError(t, err)
	assert.Equal(t, "b2 edited on mobile", b.Content, "一時エラーで取りこぼした内容が二度と取得されない")
}

func TestScenario_PeerDeletionIsApplied(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.peer.deleteNote("B")

	s.desk.sync()

	assert.Equal(t, []string{"A"}, s.desk.noteIDs())
	_, err := s.desk.readNote("B")
	assert.Error(t, err)
}

// ---- ② 表示順 ----

func TestScenario_PeerNewNoteIsFirstEvenWhenDesktopHasPendingChanges(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.desk.editNote("A", "unsynced desktop edit")
	s.peer.saveNote(s.note("P", "new on mobile"), "")

	s.desk.sync()

	assert.Equal(t, []string{"P", "B", "A"}, s.desk.topLevelNoteIDs())
	assert.Equal(t, []string{"P", "B", "A"}, s.peer.cloudTopLevelNoteIDs())
}

func TestScenario_DesktopNewNoteIsFirstInCloud(t *testing.T) {
	s := newScenario(t)
	s.seedShared()

	s.desk.createNote("M", "desktop", "m1")
	s.desk.sync()

	assert.Equal(t, []string{"M", "B", "A"}, s.peer.cloudTopLevelNoteIDs())
	m, ok := s.peer.readCloudNote("M")
	require.True(t, ok)
	assert.Equal(t, "m1", m.Content)
}

func TestScenario_FolderMembershipSurvivesCloudWinsConflict(t *testing.T) {
	s := newScenario(t)
	s.peer.createFolder("work", "Work")
	s.peer.saveNote(s.note("W1", "w1"), "work")
	s.desk.startup()
	require.Equal(t, "work", s.desk.folderOf("W1"))

	s.desk.editNote("W1", "older edit on desktop")
	// ピアがより新しい時刻で同じノートを編集（本体ファイルは folderId なしのデスクトップ形式）
	newer := s.note("W1", "newer edit on mobile")
	newer.ModifiedTime = time.Now().Add(time.Hour).UTC().Format(time.RFC3339)
	s.peer.uploadNoteFile(newer, "")
	s.peer.publishNoteMeta(newer, "work")

	s.desk.sync()

	w1, err := s.desk.readNote("W1")
	require.NoError(t, err)
	assert.Equal(t, "newer edit on mobile", w1.Content)
	assert.Equal(t, "work", s.desk.folderOf("W1"))
	meta, ok := s.peer.cloudMeta("W1")
	require.True(t, ok)
	assert.Equal(t, "work", meta.FolderID)
	assert.NotContains(t, s.desk.topLevelNoteIDs(), "W1")
}

// ---- ③ 不明ノート ----

func TestScenario_InFlightPeerNoteIsNotMovedToOrphanFolder(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	// ピアが本体だけ上げた瞬間にデスクトップが再起動
	inflight := s.note("P", "in flight")
	s.peer.uploadNoteFile(inflight, "")
	s.desk.restart()
	s.desk.startup()
	// ピアが noteList を上げ終える。デスクトップには未送信の編集がある。
	s.peer.publishNoteMeta(inflight, "")
	s.desk.editNote("A", "unsynced desktop edit")

	s.desk.sync()

	_, hasOrphanFolder := s.desk.folderNamed(legacyRecoveryFolderName)
	assert.False(t, hasOrphanFolder, "不明ノートフォルダが作られた")
	assert.Equal(t, "", s.desk.folderOf("P"))
	for _, f := range s.peer.readList().Folders {
		assert.NotEqual(t, legacyRecoveryFolderName, f.Name, "不明ノートがクラウドへ伝播した")
	}
	meta, ok := s.peer.cloudMeta("P")
	require.True(t, ok)
	assert.Equal(t, "", meta.FolderID)
}

func TestScenario_NoteCreatedDuringPullStaysInList(t *testing.T) {
	s := newScenario(t)
	s.seedShared()
	s.peer.saveNote(s.note("B", "b2 edited on mobile"), "")

	// pull が B をダウンロードする直前に、UI が新規ノートをローカル保存する
	// (App.SaveNote は noteService.SaveNote → MarkNoteDirty の順)
	s.fd.BeforeRequest(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.download" && r.FileName == "B.json"
	}, func(fakeRequest) {
		require.NoError(t, s.desk.ns.SaveNote(&Note{ID: "N", Title: "created during sync", Content: "n1", Language: "markdown"}))
	})
	s.desk.sync()
	s.desk.state.MarkNoteDirty("N")

	assert.Contains(t, s.desk.noteIDs(), "N")
	assert.Equal(t, "", s.desk.folderOf("N"), "同期中に作ったノートが不明ノートに入った")
	assert.Equal(t, "N", s.desk.topLevelNoteIDs()[0])
}
