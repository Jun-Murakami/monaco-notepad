package backend

import (
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"google.golang.org/api/drive/v3"
)

// ポーリングのテスト。同期の中身ではなく「いつ同期を走らせるか」と並行安全性を検証する。

func newPollingTestDevice(t *testing.T) (*scenario, *DrivePollingService) {
	t.Helper()
	s := newScenario(t)
	s.seedShared()
	return s, s.desk.ds.pollingService
}

// noteListReads は desktop が noteList を探しに行った回数（= 同期サイクルの回数の目安）。
func noteListReads(fd *fakeDrive) int {
	n := 0
	for _, r := range fd.Requests() {
		if r.Device == "desktop" && r.Op == "files.list" && strings.Contains(r.Query, "name='noteList_v2.json'") {
			n++
		}
	}
	return n
}

func TestHasRelevantChanges(t *testing.T) {
	assert.False(t, hasRelevantChanges(nil))
	assert.True(t, hasRelevantChanges([]*drive.Change{{File: &drive.File{Name: "abc.json"}}}), "ノート本体 / noteList の変更")
	assert.True(t, hasRelevantChanges([]*drive.Change{{Removed: true, FileId: "x"}}), "削除は常に対象")
	assert.True(t, hasRelevantChanges([]*drive.Change{{File: &drive.File{Name: "monaco-notepad"}}}), "ルートフォルダの変更（全削除など）")
	assert.False(t, hasRelevantChanges([]*drive.Change{{File: &drive.File{Name: "photo.png"}}}))
}

func TestPolling_NoChangesAndNothingPending_DoesNotSync(t *testing.T) {
	s, polling := newPollingTestDevice(t)
	before := noteListReads(s.fd)

	synced := polling.pollOnce()

	assert.False(t, synced)
	assert.Equal(t, before, noteListReads(s.fd), "変化も未送信もなければ同期しない")
}

func TestPolling_PeerChange_IsPulled(t *testing.T) {
	s, _ := newPollingTestDevice(t)
	s.peer.saveNote(s.note("P", "from mobile"), "")

	s.desk.pollOnce()

	assert.Contains(t, s.desk.noteIDs(), "P")
}

func TestPolling_LocalPendingChange_SyncsWithoutRemoteChange(t *testing.T) {
	s, _ := newPollingTestDevice(t)
	s.desk.editNote("A", "edited on desktop")
	require.True(t, s.desk.hasPendingWork())

	s.desk.pollOnce()

	cloudA, ok := s.peer.readCloudNote("A")
	require.True(t, ok)
	assert.Equal(t, "edited on desktop", cloudA.Content)
	assert.False(t, s.desk.hasPendingWork())
}

func TestPolling_ChangeDuringInitialSync_IsDetectedAfterwards(t *testing.T) {
	s := newScenario(t)
	s.peer.saveNote(s.note("A", "a1"), "")
	// 初回同期の途中（本体一覧を取得した直後）にピアが書き込む
	s.fd.BeforeRequest(func(r fakeRequest) bool {
		return isDesktop(r) && r.Op == "files.download"
	}, func(fakeRequest) {
		s.peer.saveNote(s.note("P", "during initial sync"), "")
	})
	s.desk.startup()

	s.desk.pollOnce()

	assert.Contains(t, s.desk.noteIDs(), "P", "初回同期の前に取った基準点から変更を拾う")
}

func TestPolling_SafetySync_RunsWhenDue(t *testing.T) {
	s, polling := newPollingTestDevice(t)
	polling.mu.Lock()
	polling.lastSyncAt = time.Now().Add(-safetySyncInterval - time.Second)
	polling.mu.Unlock()
	before := noteListReads(s.fd)

	synced := polling.pollOnce()

	assert.True(t, synced)
	assert.Greater(t, noteListReads(s.fd), before)
}

func TestPolling_StopPolling_Safe(t *testing.T) {
	_, polling := newPollingTestDevice(t)

	assert.NotPanics(t, func() {
		go polling.StartPolling()
		time.Sleep(50 * time.Millisecond)
		polling.StopPolling()
		time.Sleep(50 * time.Millisecond)

		go polling.StartPolling()
		time.Sleep(50 * time.Millisecond)
		polling.StopPolling()
	}, "StopPollingは安全に呼べて再開もできるべき")
}

// TestPolling_ConcurrentStopRestart は polling goroutine と sync goroutine が
// stopPollingChan / changePageToken / lastSyncAt に並行アクセスする状況を再現する（`-race` で検証）。
func TestPolling_ConcurrentStopRestart(t *testing.T) {
	_, polling := newPollingTestDevice(t)

	const cycles = 30
	done := make(chan struct{})
	go func() {
		for i := 0; i < cycles; i++ {
			go polling.StartPolling()
			time.Sleep(2 * time.Millisecond)
			polling.StopPolling()
		}
		close(done)
	}()
	for {
		select {
		case <-done:
			return
		default:
			polling.setChangePageToken("x")
			polling.markSynced()
			_ = polling.safetySyncDue()
			time.Sleep(time.Millisecond)
		}
	}
}

func TestPolling_RecordReconnectFailure_IncrementsCounter(t *testing.T) {
	_, polling := newPollingTestDevice(t)

	assert.Equal(t, 1, polling.recordReconnectFailure())
	assert.Equal(t, 2, polling.recordReconnectFailure())
	assert.Equal(t, 3, polling.recordReconnectFailure())
	assert.GreaterOrEqual(t, 3, reauthFailureThreshold, "閾値は 3 回目で到達するはず")
}

func TestPolling_ResetReconnectFailures_ResetsCounter(t *testing.T) {
	_, polling := newPollingTestDevice(t)

	polling.recordReconnectFailure()
	polling.recordReconnectFailure()
	polling.resetReconnectFailures()
	assert.Equal(t, 1, polling.recordReconnectFailure(), "resetReconnectFailures 後は再び 1 から")
}

func TestPolling_RecordReconnectFailure_ConcurrentSafe(t *testing.T) {
	_, polling := newPollingTestDevice(t)

	const goroutines = 16
	const iterations = 25
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < iterations; j++ {
				polling.recordReconnectFailure()
			}
		}()
	}
	wg.Wait()
	assert.Equal(t, goroutines*iterations+1, polling.recordReconnectFailure())
}

func TestPolling_ResetPollingInterval_NonBlocking(t *testing.T) {
	_, polling := newPollingTestDevice(t)
	polling.resetPollingChan <- struct{}{}

	done := make(chan struct{})
	go func() {
		polling.ResetPollingInterval()
		polling.ResetPollingInterval()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(time.Second):
		t.Fatal("ResetPollingInterval blocked with full channel")
	}
}
