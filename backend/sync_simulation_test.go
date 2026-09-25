package backend

import (
	"encoding/json"
	"fmt"
	"math/rand"
	"os"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

// シード付きランダム・シミュレーション（docs/sync-engine-v3.md §9 L3、デスクトップ版）。
// モバイル版 mobile/src/services/sync/__tests__/simulation.test.ts と同じ考え方:
//
// 複数のデスクトップ端末がランダムにノートの作成・編集・削除・フォルダ移動・並び替え・アーカイブを行い、
// ランダムなタイミングで同期する。同期中の任意のリクエストの直前に別端末の操作と同期を割り込ませ、
// 一時的な障害も注入する。全端末が静止したあと、次の不変条件を検証する:
//
//  1. 収束: 全端末とクラウドのノート一覧（構造・順序・所属）と本文が一致する
//  2. 最新の版が勝つ: Drive に公開された版（削除後の最新以降）のうち modifiedTime が最新のものが残る
//     （公開した端末がその後ノートを削除していれば、その版はユーザーが捨てたもの）
//  3. データ喪失なし: 誰も削除していないノートは必ず残っている
//  4. 構造が壊れていない / 不明ノートフォルダが現れない
//
// 規模は環境変数で変えられる: SIM_SEEDS / SIM_STEPS / SIM_DEVICES / SIM_SEED（単一シードの再現）

func simEnvInt(name string, def int) int {
	if v, err := strconv.Atoi(os.Getenv(name)); err == nil && v > 0 {
		return v
	}
	return def
}

// simClock は端末をまたいで単調増加する論理時計（編集ごとに 1ms 進む）。
type simClock struct {
	mu sync.Mutex
	t  time.Time
}

func (c *simClock) next() string {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.t = c.t.Add(time.Millisecond)
	return c.t.Format("2006-01-02T15:04:05.000Z07:00")
}

type simModel struct {
	mu        sync.Mutex
	created   map[string]bool
	deleted   map[string]bool
	deletedAt map[string]map[string]int // noteId -> device -> 削除時点の Drive 履歴の長さ
}

type simRun struct {
	t       *testing.T
	fd      *fakeDrive
	rng     *rand.Rand
	clock   *simClock
	model   *simModel
	devices []*desktopDevice
	log     []string
	noteSeq int

	mu      sync.Mutex
	syncing map[*desktopDevice]bool
}

func (r *simRun) logf(format string, args ...any) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.log = append(r.log, fmt.Sprintf(format, args...))
}

// ---- 端末操作（App の手順 + 論理時計での modifiedTime） ----

func (d *desktopDevice) stampNote(id, ts string) {
	d.t.Helper()
	d.ns.WithLock(func() {
		note, err := d.ns.loadNoteLocked(id)
		require.NoError(d.t, err)
		cp := *note
		cp.ModifiedTime = ts
		require.NoError(d.t, d.ns.saveNoteFromSyncLocked(&cp))
		for i, m := range d.ns.noteList.Notes {
			if m.ID == id {
				d.ns.noteList.Notes[i].ModifiedTime = ts
			}
		}
		require.NoError(d.t, d.ns.saveNoteList())
	})
}

func (r *simRun) localOp(d *desktopDevice) {
	snap := d.ns.SnapshotNoteList()
	var active []NoteMetadata
	for _, n := range snap.Notes {
		if !n.Archived {
			active = append(active, n)
		}
	}
	roll := r.rng.Float64()
	switch {
	case roll < 0.22:
		r.noteSeq++
		id := fmt.Sprintf("N%d", r.noteSeq)
		require.NoError(r.t, d.ns.SaveNote(&Note{ID: id, Title: "t-" + id, Content: "c-" + id + "-0", Language: "markdown"}))
		d.state.MarkNoteDirty(id)
		d.stampNote(id, r.clock.next())
		r.model.mu.Lock()
		r.model.created[id] = true
		r.model.mu.Unlock()
		r.logf("%s: create %s", d.name, id)
	case roll < 0.50:
		if len(snap.Notes) == 0 {
			return
		}
		target := snap.Notes[r.rng.Intn(len(snap.Notes))]
		content := fmt.Sprintf("c-%s-%s-%d", target.ID, d.name, r.rng.Intn(1_000_000))
		d.editNote(target.ID, content)
		d.stampNote(target.ID, r.clock.next())
		r.logf("%s: edit %s", d.name, target.ID)
	case roll < 0.58:
		if len(snap.Notes) == 0 {
			return
		}
		target := snap.Notes[r.rng.Intn(len(snap.Notes))]
		d.deleteNote(target.ID)
		r.model.mu.Lock()
		r.model.deleted[target.ID] = true
		if r.model.deletedAt[target.ID] == nil {
			r.model.deletedAt[target.ID] = map[string]int{}
		}
		r.model.deletedAt[target.ID][d.name] = len(r.fd.NoteHistory())
		r.model.mu.Unlock()
		r.logf("%s: delete %s", d.name, target.ID)
	case roll < 0.66:
		folder, err := d.ns.CreateFolder(fmt.Sprintf("F-%s-%d", d.name, r.rng.Intn(1000)))
		require.NoError(r.t, err)
		d.state.MarkDirty()
		r.logf("%s: createFolder %s", d.name, folder.ID)
	case roll < 0.76:
		if len(active) == 0 {
			return
		}
		target := active[r.rng.Intn(len(active))]
		options := []string{""}
		for _, f := range snap.Folders {
			if !f.Archived {
				options = append(options, f.ID)
			}
		}
		folderID := options[r.rng.Intn(len(options))]
		require.NoError(r.t, d.ns.MoveNoteToFolder(target.ID, folderID))
		d.state.MarkDirty()
		d.state.MarkNoteDirty(target.ID)
		r.logf("%s: move %s -> %q", d.name, target.ID, folderID)
	case roll < 0.88:
		order := append([]TopLevelItem(nil), snap.TopLevelOrder...)
		if len(order) < 2 {
			return
		}
		i := r.rng.Intn(len(order))
		item := order[i]
		order = append(order[:i], order[i+1:]...)
		j := r.rng.Intn(len(order) + 1)
		order = append(order[:j], append([]TopLevelItem{item}, order[j:]...)...)
		require.NoError(r.t, d.ns.UpdateTopLevelOrder(order))
		d.state.MarkDirty()
		r.logf("%s: reorder %s:%s", d.name, item.Type, item.ID)
	default:
		if len(snap.Notes) == 0 {
			return
		}
		target := snap.Notes[r.rng.Intn(len(snap.Notes))]
		note, err := d.ns.LoadNote(target.ID)
		require.NoError(r.t, err)
		updated := *note
		updated.Archived = !target.Archived
		updated.FolderID = target.FolderID
		require.NoError(r.t, d.ns.SaveNote(&updated))
		d.state.MarkNoteDirty(target.ID)
		d.stampNote(target.ID, r.clock.next())
		r.logf("%s: archived=%v %s", d.name, updated.Archived, target.ID)
	}
}

func (r *simRun) syncDevice(d *desktopDevice) {
	r.mu.Lock()
	r.syncing[d] = true
	r.mu.Unlock()
	defer func() {
		r.mu.Lock()
		delete(r.syncing, d)
		r.mu.Unlock()
	}()
	if err := d.trySync(); err != nil {
		r.logf("  %s sync failed: %v", d.name, err)
	}
}

func (r *simRun) isSyncing(d *desktopDevice) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.syncing[d]
}

// ---- 検証 ----

func canonicalNoteList(list *NoteList) string {
	type meta struct {
		ID, FolderID, Title, ContentHash string
		Archived                         bool
	}
	notes := []meta{}
	for _, n := range list.Notes {
		notes = append(notes, meta{n.ID, n.FolderID, n.Title, n.ContentHash, n.Archived})
	}
	orNil := func(items []TopLevelItem) []TopLevelItem {
		if items == nil {
			return []TopLevelItem{}
		}
		return items
	}
	folders := list.Folders
	if folders == nil {
		folders = []Folder{}
	}
	collapsed := list.CollapsedFolderIDs
	if collapsed == nil {
		collapsed = []string{}
	}
	data, _ := json.Marshal(map[string]any{
		"notes": notes, "folders": folders, "top": orNil(list.TopLevelOrder),
		"archived": orNil(list.ArchivedTopLevelOrder), "collapsed": collapsed,
	})
	return string(data)
}

func checkNoteListStructure(t *testing.T, list *NoteList, label string) {
	t.Helper()
	seen := map[string]bool{}
	folders := foldersByID(list.Folders)
	notes := notesByID(list.Notes)
	for _, n := range list.Notes {
		require.False(t, seen[n.ID], "%s: notes に重複 %s", label, n.ID)
		seen[n.ID] = true
		if n.FolderID != "" {
			_, ok := folders[n.FolderID]
			require.True(t, ok, "%s: %s の所属フォルダが無い", label, n.ID)
		}
	}
	for _, pair := range []struct {
		order    []TopLevelItem
		archived bool
	}{{list.TopLevelOrder, false}, {list.ArchivedTopLevelOrder, true}} {
		keys := map[string]bool{}
		for _, item := range pair.order {
			key := itemKey(item)
			require.False(t, keys[key], "%s: 順序に重複 %s", label, key)
			keys[key] = true
			if item.Type == "note" {
				n, ok := notes[item.ID]
				require.True(t, ok && n.FolderID == "" && n.Archived == pair.archived, "%s: 順序の不正なノート %s", label, item.ID)
			} else {
				f, ok := folders[item.ID]
				require.True(t, ok && f.Archived == pair.archived, "%s: 順序の不正なフォルダ %s", label, item.ID)
			}
		}
	}
	for _, n := range list.Notes {
		if n.FolderID != "" {
			continue
		}
		order := list.TopLevelOrder
		if n.Archived {
			order = list.ArchivedTopLevelOrder
		}
		require.NotEqual(t, -1, indexOfItem(order, TopLevelItem{Type: "note", ID: n.ID}), "%s: %s が順序に無い", label, n.ID)
	}
	for _, f := range list.Folders {
		require.NotEqual(t, RecoveryFolderName, f.Name, "%s: 不明ノートが現れた", label)
	}
}

func indexOfItem(order []TopLevelItem, target TopLevelItem) int {
	for i, item := range order {
		if item == target {
			return i
		}
	}
	return -1
}

// newestPublished は Drive に公開された版のうち、最後に消えた後で、公開した端末が
// その後削除していないものの中から modifiedTime が最新の版を返す。
func (r *simRun) newestPublished(id string) (*Note, bool) {
	history := r.fd.NoteHistory()
	lastGone := -1
	for i, h := range history {
		if h.Name == id+".json" && h.Kind == "gone" {
			lastGone = i
		}
	}
	var newest *Note
	for i := lastGone + 1; i < len(history); i++ {
		h := history[i]
		if h.Name != id+".json" || h.Kind != "upload" {
			continue
		}
		if at, ok := r.model.deletedAt[id][h.Device]; ok && i < at {
			continue
		}
		var n Note
		if err := json.Unmarshal(h.Content, &n); err != nil {
			continue
		}
		if newest == nil || n.ModifiedTime >= newest.ModifiedTime {
			cp := n
			newest = &cp
		}
	}
	return newest, newest != nil
}

func runSyncSimulation(t *testing.T, seed int64, deviceCount, steps int) {
	fd := newFakeDrive(t)
	r := &simRun{
		t: t, fd: fd, rng: rand.New(rand.NewSource(seed)),
		clock:   &simClock{t: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)},
		model:   &simModel{created: map[string]bool{}, deleted: map[string]bool{}, deletedAt: map[string]map[string]int{}},
		syncing: map[*desktopDevice]bool{},
	}
	for i := 0; i < deviceCount; i++ {
		d := newDesktopDevice(t, fd, fmt.Sprintf("dev%d", i))
		d.connectLazy()
		r.devices = append(r.devices, d)
	}
	defer func() {
		if t.Failed() {
			t.Logf("simulation seed=%d log:\n%s", seed, strings.Join(r.log, "\n"))
		}
	}()

	ops := []string{"files.list", "files.download", "files.create", "files.update", "files.delete"}
	for step := 0; step < steps; step++ {
		d := r.devices[r.rng.Intn(len(r.devices))]
		if r.rng.Float64() < 0.55 {
			r.localOp(d)
			continue
		}
		fd.mu.Lock()
		fd.hooks = nil
		fd.failures = nil
		fd.mu.Unlock()
		if r.rng.Float64() < 0.35 {
			others := []*desktopDevice{}
			for _, x := range r.devices {
				if x != d {
					others = append(others, x)
				}
			}
			other := others[r.rng.Intn(len(others))]
			countdown := 1 + r.rng.Intn(12)
			name := d.name
			fd.BeforeRequest(func(req fakeRequest) bool {
				if req.Device != name {
					return false
				}
				countdown--
				return countdown == 0
			}, func(fakeRequest) {
				r.logf("  %s interleaves into %s's sync", other.name, name)
				r.localOp(other)
				if !r.isSyncing(other) {
					r.syncDevice(other)
				}
			})
		}
		if r.rng.Float64() < 0.15 {
			op := ops[r.rng.Intn(len(ops))]
			name := d.name
			fd.FailWhen(func(req fakeRequest) bool { return req.Device == name && req.Op == op }, 503, 1)
			r.logf("  inject 503 on %s %s", name, op)
		}
		r.logf("%s: sync", d.name)
		r.syncDevice(d)
	}

	// 静止化
	fd.mu.Lock()
	fd.hooks = nil
	fd.failures = nil
	fd.mu.Unlock()
	converged := false
	var lists []string
	for round := 0; round < 6 && !converged; round++ {
		for _, d := range r.devices {
			require.NoError(t, d.trySync(), "quiesce sync")
		}
		lists = lists[:0]
		pending := false
		for _, d := range r.devices {
			lists = append(lists, canonicalNoteList(d.ns.SnapshotNoteList()))
			pending = pending || d.hasPendingWork()
		}
		converged = !pending
		for _, l := range lists {
			converged = converged && l == lists[0]
		}
	}
	if !converged {
		for i, d := range r.devices {
			r.logf("%s list: %s", d.name, lists[i])
		}
	}
	require.True(t, converged, "端末が収束しない")

	// クラウドの noteList も同じ
	var cloudList *NoteList
	for _, f := range fd.sortedFilesLocked() {
		if f.Name == "noteList_v2.json" {
			list, err := decodeNoteList(f.Content)
			require.NoError(t, err)
			cloudList = list
			break
		}
	}
	require.NotNil(t, cloudList)
	require.Equal(t, lists[0], canonicalNoteList(cloudList), "クラウドの noteList が端末と違う")

	final := r.devices[0].ns.SnapshotNoteList()
	for _, d := range r.devices {
		checkNoteListStructure(t, d.ns.SnapshotNoteList(), d.name)
	}
	existing := map[string]bool{}
	for _, n := range final.Notes {
		existing[n.ID] = true
	}
	ids := make([]string, 0, len(r.model.created))
	for id := range r.model.created {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	for _, id := range ids {
		if !r.model.deleted[id] {
			require.True(t, existing[id], "誰も削除していない %s が消えた", id)
		}
	}
	for id := range existing {
		want, ok := r.newestPublished(id)
		require.True(t, ok, "%s が Drive に公開されていない", id)
		for _, d := range r.devices {
			got, err := d.readNote(id)
			require.NoError(t, err)
			require.Equal(t, want.Content, got.Content, "%s: %s が最新の版ではない", d.name, id)
			require.Equal(t, want.Archived, got.Archived, "%s: %s の archived が最新の版ではない", d.name, id)
		}
	}
}

func TestSyncSimulation_MultipleDesktops(t *testing.T) {
	deviceCount := simEnvInt("SIM_DEVICES", 3)
	steps := simEnvInt("SIM_STEPS", 40)
	if seed := simEnvInt("SIM_SEED", 0); seed > 0 {
		runSyncSimulation(t, int64(seed), deviceCount, steps)
		return
	}
	for i := 0; i < simEnvInt("SIM_SEEDS", 12); i++ {
		seed := int64(1000 + i)
		t.Run(fmt.Sprintf("seed%d", seed), func(t *testing.T) {
			runSyncSimulation(t, seed, deviceCount, steps)
		})
	}
}
