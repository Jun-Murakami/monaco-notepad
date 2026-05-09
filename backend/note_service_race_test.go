package backend

import (
	"fmt"
	"sync"
	"testing"
	"time"
)

// 「ノート保存ができない時がある」バグの根本原因 (race condition) を
// 再現するテスト群。`go test -race` で走らせると DATA RACE が検出される。
//
// noteService には mutex がないため、UI 経路の SaveNote と
// Drive 同期 goroutine の SaveNoteFromSync / noteList 直接書き換えが
// 衝突してデータレースになる。実機では:
//   - saveNoteList の atomic rename が共有違反 (Windows) で失敗
//   - json.MarshalIndent 実行中にスライスが変更されて出力が破損
//   - s.noteCache への concurrent map writes で fatal error
// を引き起こす。

// TestSaveNote_ConcurrentWithSyncWrites はユーザー編集と Drive 同期を
// 並行で走らせ、`-race` で DATA RACE が出ないこと、
// プロセスが panic せず保存も失敗しないことを確認する。
//
// 修正前: -race で DATA RACE が出る (s.noteList.Notes / s.noteCache)。
// 修正後: race なし、保存もすべて成功。
func TestSaveNote_ConcurrentWithSyncWrites(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	const noteID = "concurrent-save-target"
	// 初期ノートを 1 つ用意。これに対し 2 経路から書き込む。
	initial := &Note{
		ID:           noteID,
		Title:        "init",
		Content:      "init",
		Language:     "plaintext",
		ModifiedTime: time.Now().Format(time.RFC3339),
	}
	if err := helper.noteService.SaveNote(initial); err != nil {
		t.Fatalf("initial SaveNote failed: %v", err)
	}

	const iterations = 50
	var wg sync.WaitGroup
	wg.Add(2)

	saveErrors := make(chan error, iterations)
	syncErrors := make(chan error, iterations)

	// goroutine A: UI 経路をシミュレートして公開 SaveNote を連打
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			note := &Note{
				ID:           noteID,
				Title:        "ui",
				Content:      fmt.Sprintf("ui-%d", i),
				Language:     "plaintext",
				ModifiedTime: time.Now().Format(time.RFC3339),
			}
			if err := helper.noteService.SaveNote(note); err != nil {
				saveErrors <- fmt.Errorf("ui SaveNote iter %d: %w", i, err)
			}
		}
	}()

	// goroutine B: Drive 同期経路をシミュレートして SaveNoteFromSync を連打
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			note := &Note{
				ID:           noteID,
				Title:        "sync",
				Content:      fmt.Sprintf("sync-%d", i),
				Language:     "plaintext",
				ModifiedTime: time.Now().Format(time.RFC3339),
			}
			if err := helper.noteService.SaveNoteFromSync(note); err != nil {
				syncErrors <- fmt.Errorf("sync SaveNoteFromSync iter %d: %w", i, err)
			}
		}
	}()

	wg.Wait()
	close(saveErrors)
	close(syncErrors)

	for err := range saveErrors {
		t.Errorf("UI save failed: %v", err)
	}
	for err := range syncErrors {
		t.Errorf("Sync save failed: %v", err)
	}
}

// TestSaveNote_ConcurrentDifferentNotes は別ノートへの並行 SaveNote が
// noteList スライスや noteCache map の race を引き起こさないこと。
// `-race` 必須。
func TestSaveNote_ConcurrentDifferentNotes(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	const numWorkers = 8
	const iterations = 30

	var wg sync.WaitGroup
	wg.Add(numWorkers)

	for w := 0; w < numWorkers; w++ {
		workerID := w
		go func() {
			defer wg.Done()
			for i := 0; i < iterations; i++ {
				noteID := fmt.Sprintf("worker-%d-note-%d", workerID, i)
				note := &Note{
					ID:           noteID,
					Title:        fmt.Sprintf("w%d-i%d", workerID, i),
					Content:      "x",
					Language:     "plaintext",
					ModifiedTime: time.Now().Format(time.RFC3339),
				}
				if err := helper.noteService.SaveNote(note); err != nil {
					t.Errorf("worker %d iter %d: SaveNote failed: %v", workerID, i, err)
				}
			}
		}()
	}

	wg.Wait()
}

// TestSaveNote_ConcurrentWithDriveLikeMutation は drive_service が noteList の
// フィールドを WithLock 内で一括置換する経路 (例: pull/conflict resolution) と、
// ユーザー編集の SaveNote の並行を再現する。
//
// 修正前 (Phase A 適用前): drive_service が WithLock を介さず直接 noteList を
// 書き換えていたため、UI の SaveNote 中の json.MarshalIndent が破壊されて panic。
// Phase B 適用後: WithLock + SaveNoteList を経由するので race ゼロ。
func TestSaveNote_ConcurrentWithDriveLikeMutation(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// 初期ノートを 5 件用意
	for i := 0; i < 5; i++ {
		note := &Note{
			ID:           fmt.Sprintf("init-%d", i),
			Title:        fmt.Sprintf("init-%d", i),
			Content:      "x",
			Language:     "plaintext",
			ModifiedTime: time.Now().Format(time.RFC3339),
		}
		if err := helper.noteService.SaveNote(note); err != nil {
			t.Fatalf("seed SaveNote failed: %v", err)
		}
	}

	const iterations = 30
	var wg sync.WaitGroup
	wg.Add(2)

	// goroutine A: UI 経路の SaveNote 連打
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			note := &Note{
				ID:           "ui-target",
				Title:        fmt.Sprintf("ui-%d", i),
				Content:      fmt.Sprintf("content-%d", i),
				Language:     "plaintext",
				ModifiedTime: time.Now().Format(time.RFC3339),
			}
			if err := helper.noteService.SaveNote(note); err != nil {
				t.Errorf("UI SaveNote iter %d: %v", i, err)
			}
		}
	}()

	// goroutine B: drive_service が pull 結果で noteList 全体を置換するパターン
	// (s.noteService.WithLock(func() { ... cloud values ... saveNoteList() }))
	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			cloudNotes := []NoteMetadata{
				{
					ID:           fmt.Sprintf("cloud-%d-a", i),
					Title:        "cloud-a",
					Language:     "plaintext",
					ModifiedTime: time.Now().Format(time.RFC3339),
				},
				{
					ID:           fmt.Sprintf("cloud-%d-b", i),
					Title:        "cloud-b",
					Language:     "plaintext",
					ModifiedTime: time.Now().Format(time.RFC3339),
				},
			}
			var saveErr error
			helper.noteService.WithLock(func() {
				helper.noteService.noteList.Notes = cloudNotes
				saveErr = helper.noteService.saveNoteList()
			})
			if saveErr != nil {
				t.Errorf("drive-like saveNoteList iter %d: %v", i, saveErr)
			}
		}
	}()

	wg.Wait()
}

// TestListNotes_ConcurrentWithSaveNote は読み取り経路 (ListNotes) と
// 書き込み経路 (SaveNote) の並行アクセスが race にならないこと。
// 実機では ListNotes が UI 表示用に頻繁に呼ばれる一方で、
// 編集中は SaveNote が走るため、この組み合わせは日常的に発生する。
func TestListNotes_ConcurrentWithSaveNote(t *testing.T) {
	helper := setupNoteTest(t)
	defer helper.cleanup()

	// ベースとなるノートを 5 つ作る
	for i := 0; i < 5; i++ {
		note := &Note{
			ID:           fmt.Sprintf("base-%d", i),
			Title:        fmt.Sprintf("base-%d", i),
			Content:      "x",
			Language:     "plaintext",
			ModifiedTime: time.Now().Format(time.RFC3339),
		}
		if err := helper.noteService.SaveNote(note); err != nil {
			t.Fatalf("seed SaveNote failed: %v", err)
		}
	}

	const iterations = 50
	var wg sync.WaitGroup
	wg.Add(2)

	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			if _, err := helper.noteService.ListNotes(); err != nil {
				t.Errorf("ListNotes iter %d: %v", i, err)
			}
		}
	}()

	go func() {
		defer wg.Done()
		for i := 0; i < iterations; i++ {
			note := &Note{
				ID:           "writer-target",
				Title:        fmt.Sprintf("writer-%d", i),
				Content:      "x",
				Language:     "plaintext",
				ModifiedTime: time.Now().Format(time.RFC3339),
			}
			if err := helper.noteService.SaveNote(note); err != nil {
				t.Errorf("writer SaveNote iter %d: %v", i, err)
			}
		}
	}()

	wg.Wait()
}
