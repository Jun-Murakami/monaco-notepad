package backend

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// Windows では Startup と DomReady が別 goroutine で呼ばれる。
// ディスク読み込みが遅い起動を、サービスが未設定のまま固定して再現する。
func TestDomReadyWaitsForStartup(t *testing.T) {
	app := NewApp()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan interface{}, 1)
	go func() {
		defer func() { done <- recover() }()
		app.DomReady(ctx)
	}()
	select {
	case failure := <-done:
		t.Fatalf("DomReady accessed services before Startup completed: %v", failure)
	case <-time.After(50 * time.Millisecond):
	}
	cancel()
	select {
	case failure := <-done:
		if failure != nil {
			t.Fatalf("DomReady panicked on shutdown: %v", failure)
		}
	case <-time.After(time.Second):
		t.Fatal("DomReady did not stop waiting on shutdown")
	}
}

func TestBackendReadyLoads170NotesAfterSlowStartup(t *testing.T) {
	app := NewApp()
	done := make(chan []Note, 1)
	go func() {
		app.WaitForBackendReady()
		notes, _ := app.ListNotes()
		done <- notes
	}()

	// 読み込み中は一覧要求を始めない。固定時間後に空リストを返さない。
	select {
	case <-done:
		t.Fatal("notes were loaded before backend initialization")
	case <-time.After(50 * time.Millisecond):
	}
	dir := t.TempDir()
	require.NoError(t, os.MkdirAll(filepath.Join(dir, "notes"), 0755))
	logger := NewAppLogger(context.Background(), true, dir)
	service, err := NewNoteService(filepath.Join(dir, "notes"), logger)
	require.NoError(t, err)
	for i := 0; i < 170; i++ {
		require.NoError(t, service.SaveNote(&Note{
			ID: fmt.Sprintf("note-%03d", i), Title: fmt.Sprintf("Note %d", i),
			Content: fmt.Sprintf("Content %d", i), Language: "plaintext",
			ModifiedTime: time.Now().Format(time.RFC3339),
		}))
	}
	// 再起動と同じくディスクから再構築する。
	app.noteService, err = NewNoteService(filepath.Join(dir, "notes"), logger)
	require.NoError(t, err)
	close(app.startupReady)
	select {
	case <-done:
		t.Fatal("React started before DomReady completed")
	case <-time.After(50 * time.Millisecond):
	}
	close(app.backendReady)
	select {
	case notes := <-done:
		require.Len(t, notes, 170)
		for _, note := range notes {
			require.NotEmpty(t, note.Content)
		}
	case <-time.After(time.Second):
		t.Fatal("notes were not loaded after backend initialization")
	}
	// 準備完了後の呼び出しもブロックしない（イベントの取り逃し対策）。
	completed := make(chan struct{})
	go func() { app.WaitForBackendReady(); close(completed) }()
	select {
	case <-completed:
	case <-time.After(time.Second):
		t.Fatal("missed backend readiness")
	}
}
