package backend

import (
	"context"
	"fmt"
	"sort"
	"sync"

	"github.com/google/uuid"
)

// 同期エンジン v3（docs/sync-engine-v3.md §5）。モバイル版 mobile/src/services/sync/syncEngine.ts と同じ手順。
//
// 1 サイクル:
//
//	リモート読み取り → ローカルのスナップショット → ノート判定（decideNote）→ ダウンロード →
//	本体のアップロード / 削除 → ローカルコミット（noteService のロック内で現在のローカルと再マージ）→
//	noteList アップロード（直前に再確認し、他端末の書き込みがあればやり直し）→ base 更新
//
// 失敗したノートは base を進めない（次サイクルで必ず再試行される）。

type syncEngineOptions struct {
	// 競合で負けた / リモートで削除されたローカル版をバックアップするか（nil なら常に true）。
	backupEnabled func() bool
	// kind は "cloud_wins" / "cloud_delete" / "local_wins"。kept が残す版。
	// noteService のロック内から呼ばれることがあるので noteService を触らないこと。
	backup func(kind string, kept *Note, other *Note) error
	// noteList の書き込みが他端末と競合したときの最大試行回数（0 なら 3）。
	maxAttempts int
	// recoveredTitle は復帰ノートのタイトル（nil なら英語の接尾辞）。
	recoveredTitle func(title string) string
}

type syncReport struct {
	Uploaded      int
	Downloaded    int
	DeletedLocal  int
	DeletedRemote int
	Failures      int
	ListUploaded  bool
	LocalChanged  bool
	Attempts      int
}

type syncEngine struct {
	ctx       context.Context
	gateway   *driveGateway
	notes     *noteService
	state     *SyncState
	baseStore *syncBaseStore
	logger    AppLogger
	opts      syncEngineOptions

	mu         sync.Mutex
	baseCache  *SyncBase
	baseLoaded bool
	// verifiedAll は起動後に全ノートの本体をノート一覧の記録と照合し終えたか（失敗の無いサイクルを 1 回終えたら true）。
	verifiedAll bool
}

func newSyncEngine(ctx context.Context, gateway *driveGateway, notes *noteService, state *SyncState,
	baseStore *syncBaseStore, logger AppLogger, opts syncEngineOptions) *syncEngine {
	return &syncEngine{ctx: ctx, gateway: gateway, notes: notes, state: state, baseStore: baseStore, logger: logger, opts: opts}
}

// Sync は同期を 1 回実行する（端末内で直列化される）。
func (e *syncEngine) Sync() (syncReport, error) {
	e.mu.Lock()
	defer e.mu.Unlock()

	maxAttempts := e.opts.maxAttempts
	if maxAttempts <= 0 {
		maxAttempts = 3
	}
	var report syncReport
	for attempt := 1; attempt <= maxAttempts; attempt++ {
		r, retry, err := e.runCycle()
		r.Attempts = attempt
		r.LocalChanged = r.LocalChanged || report.LocalChanged
		report = r
		if err != nil {
			return report, err
		}
		if !retry {
			break
		}
	}
	return report, nil
}

// HasPendingWork は同期しないと解消しない状態か（未送信のローカル変更がある / 一度も同期していない）。
func (e *syncEngine) HasPendingWork() bool {
	if e.state.IsDirty() {
		return true
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.loadBase() == nil
}

// ResetBase はサインアウト / Drive 全削除時に base を破棄する。
func (e *syncEngine) ResetBase() error {
	e.mu.Lock()
	defer e.mu.Unlock()
	e.baseCache = nil
	e.baseLoaded = true
	e.verifiedAll = false
	e.gateway.InvalidateLayout()
	return e.baseStore.Clear()
}

type downloadedNote struct {
	note    *Note
	hash    string
	lineage noteLineage // 書いた端末が置き換えた版と、見ずに上書きされた版番号（不明なら空）
}

// recoveredLocal は復帰ノートとして分けたローカルの版。
type recoveredLocal struct {
	originalID string
	note       *Note
}

type uploadedNote struct {
	ref     remoteFileRef
	note    *Note
	hash    string
	lineage noteLineage // この書き込みに付けた系譜
}

// decisionSkip はダウンロードに失敗して判定できなかったノート（base を進めない）。
const decisionSkip decisionKind = "skip"

// maxRecoveredNotesPerSync は 1 回の同期で復帰ノートとして分ける上限。これを超えて食い違うのは
// 個々のノートの不具合の名残ではなく仕組み側の問題（ハッシュの計算方法の変更など）が疑われるので、分けずにそのままにする。
const maxRecoveredNotesPerSync = 10

// recoveredNoteTitle は復帰ノート（出どころ不明のローカルの内容を分けたノート）のタイトル。
func recoveredNoteTitle(title, locale string) string {
	if locale == LocaleJapanese {
		return title + "(復帰済み)"
	}
	return title + " (Recovered)"
}

func (e *syncEngine) runCycle() (syncReport, bool, error) {
	var report syncReport
	e.logger.NotifyDriveStatus(e.ctx, "syncing")

	// ---- 1. リモート読み取り ----
	layout, err := e.gateway.ResolveLayout()
	if err != nil {
		return report, false, err
	}
	listRef, err := e.gateway.FindNoteList(layout)
	if err != nil {
		return report, false, err
	}
	if listRef == nil {
		// noteList が無い = 初回、または別端末が Drive のデータを全削除した。
		// 後者だとキャッシュしたフォルダ ID が消えているので、解決し直す。
		e.gateway.InvalidateLayout()
		if layout, err = e.gateway.ResolveLayout(); err != nil {
			return report, false, err
		}
		if listRef, err = e.gateway.FindNoteList(layout); err != nil {
			return report, false, err
		}
	}
	remoteFiles, err := e.gateway.ListNoteFiles(layout)
	if err != nil {
		return report, false, err
	}
	base := e.effectiveBase(layout, listRef)
	var remoteList *NoteList
	if listRef != nil {
		if base.NoteList != nil && base.NoteListFileID == listRef.FileID && base.NoteListMd5 != "" && base.NoteListMd5 == listRef.Md5 {
			remoteList = base.NoteList
		} else if remoteList, err = e.gateway.DownloadNoteList(listRef.FileID); err != nil {
			return report, false, err
		}
	}

	// ---- 2. ローカルのスナップショット ----
	// 整合性チェックが自動で消したノート（重複した conflict copy 等）は削除意図として記録する
	for _, id := range e.notes.DrainAutoDeletedNoteIDs() {
		e.state.MarkNoteDeleted(id)
	}
	dirtyIDs, deletedIDs, _, _, revision := e.state.GetDirtySnapshotWithRevision()
	localList := e.notes.SnapshotNoteList()
	localMeta := notesByID(localList.Notes)
	localState := map[string]noteSideState{}
	for _, meta := range localList.Notes {
		if dirtyIDs[meta.ID] || meta.ContentHash == "" {
			note, err := e.notes.LoadNote(meta.ID)
			if err != nil {
				continue // 本体が読めないノートはローカルに無いものとして扱う
			}
			localState[meta.ID] = noteSideState{Hash: computeContentHash(note), ModifiedTime: note.ModifiedTime}
		} else {
			localState[meta.ID] = noteSideState{Hash: meta.ContentHash, ModifiedTime: meta.ModifiedTime}
		}
	}

	// ---- 3. ノート判定フェーズ1 → ダウンロード → フェーズ2 ----
	idSet := map[string]bool{}
	for id := range localState {
		idSet[id] = true
	}
	for id := range remoteFiles.ByNoteID {
		idSet[id] = true
	}
	for id := range base.Notes {
		idSet[id] = true
	}
	for id := range deletedIDs {
		idSet[id] = true
	}
	ids := make([]string, 0, len(idSet))
	for id := range idSet {
		ids = append(ids, id)
	}
	sort.Strings(ids)

	inputs := map[string]decideNoteInput{}
	decisions := map[string]noteDecision{}
	for _, id := range ids {
		in := decideNoteInput{LocalDeleted: deletedIDs[id]}
		if l, ok := localState[id]; ok {
			l := l
			in.Local = &l
		}
		if b, ok := base.Notes[id]; ok {
			in.Base = &baseNoteState{Hash: b.Hash, Md5: b.Md5, FileID: b.FileID, Version: b.Version}
		}
		if r, ok := remoteFiles.ByNoteID[id]; ok {
			in.Remote = &remoteNoteState{Md5: r.Md5, FileID: r.FileID, Version: r.Version}
		}
		inputs[id] = in
		decisions[id] = decideNote(in)
	}

	// 何かをする前には本体で確かめる。上の判定はノート一覧に記録された ContentHash で手元の状態を見ている
	// （全ノートの本体を毎回読まないため）が、記録が本体と食い違っていると、変わっていないノートを送り続けたり
	// （送るたびに相手が同期して終わらない）、一覧が知らない本体の内容を黙って上書き・削除したりする。
	// 起動後の最初のサイクルは全ノートを照合する（判定上は何もしないノートの本体が、記録とも前回同期した版とも
	// 違うことがある。過去のバージョンの不具合の名残など）。以後は何かをするノートだけ。
	verified := map[string]*Note{}
	for _, id := range ids {
		if e.verifiedAll {
			switch decisions[id].Kind {
			case decisionUpload, decisionDownload, decisionDeleteLocal:
			default:
				continue
			}
		}
		meta, ok := localMeta[id]
		if !ok || dirtyIDs[id] || meta.ContentHash == "" {
			continue // 本体から計算済み
		}
		note, err := e.notes.LoadNote(id)
		if err != nil {
			continue
		}
		fileHash := computeContentHash(note)
		if fileHash == meta.ContentHash {
			continue
		}
		verified[id] = note
		localState[id] = noteSideState{Hash: fileHash, ModifiedTime: note.ModifiedTime}
		in := inputs[id]
		l := localState[id]
		in.Local = &l
		// 前回同期した版とも違い、編集の記録も無い = 出どころ不明の内容。勝敗を決めず両方残す（復帰ノート）
		in.LocalUnrecorded = in.Base != nil && fileHash != in.Base.Hash
		inputs[id] = in
		decisions[id] = decideNote(in)
	}

	var toDownload []string
	for _, id := range ids {
		if decisions[id].Kind == decisionDownload {
			toDownload = append(toDownload, id)
		}
	}

	downloaded := map[string]downloadedNote{}
	for i, id := range toDownload {
		e.logger.InfoCode(MsgDriveSyncDownloadNote, map[string]interface{}{"noteId": id, "current": i + 1, "total": len(toDownload)})
		note, lineage, err := e.gateway.DownloadNote(remoteFiles.ByNoteID[id].FileID, id)
		if err != nil {
			if isAuthDriveError(err) {
				return report, false, err
			}
			e.logger.ErrorCode(err, MsgDriveErrorDownloadNote, map[string]interface{}{"noteId": id})
			report.Failures++
			continue
		}
		if note == nil {
			report.Failures++
			continue
		}
		downloaded[id] = downloadedNote{note: note, hash: computeContentHash(note), lineage: lineage}
		report.Downloaded++
	}
	for _, id := range toDownload {
		dl, ok := downloaded[id]
		if !ok {
			decisions[id] = noteDecision{Kind: decisionSkip}
			continue
		}
		in := inputs[id]
		in.Downloaded = &noteSideState{
			Hash: dl.hash, ModifiedTime: dl.note.ModifiedTime,
			ParentVersion: dl.lineage.ParentVersion, Skipped: dl.lineage.Skipped,
		}
		decisions[id] = decideNote(in)
	}

	// 一度に大量の復帰ノートは作らない（仕組み側の問題が疑われる）。そのままにして知らせるだけ（base も記録も進めない）
	var recoverIDs []string
	for _, id := range ids {
		if d := decisions[id]; d.Kind == decisionApplyRemote && d.RecoverLocal {
			recoverIDs = append(recoverIDs, id)
		}
	}
	if len(recoverIDs) > maxRecoveredNotesPerSync {
		for _, id := range recoverIDs {
			decisions[id] = noteDecision{Kind: decisionSkip}
		}
		e.logger.InfoCode(MsgDriveSyncRecoveryLimited, map[string]interface{}{"count": len(recoverIDs)})
	}

	// skippedOf は置き換える版の「履歴の中で見ずに上書きされた版番号」。このサイクルで落とした版はその系譜から、
	// 落とさずに書く（Drive が base のまま）なら base に覚えている値を引き継ぐ。
	skippedOf := func(id string) []versionRange {
		remote, ok := remoteFiles.ByNoteID[id]
		if !ok {
			return nil
		}
		if dl, ok := downloaded[id]; ok {
			return knownSkippedVersions(dl.lineage.Skipped, dl.lineage.ParentVersion, remote.Version)
		}
		return base.Notes[id].Skipped
	}

	// ---- 4. 本体のアップロード / 削除 ----
	var uploadIDs []string
	for _, id := range ids {
		if decisions[id].Kind == decisionUpload {
			uploadIDs = append(uploadIDs, id)
		}
	}
	backupEnabled := e.opts.backupEnabled == nil || e.opts.backupEnabled()
	uploaded := map[string]uploadedNote{}
	for i, id := range uploadIDs {
		// 真の競合でローカルが勝った: 上書きする前に、負けたリモートの版をこの端末に残す
		if decisions[id].BackupRemote && backupEnabled && e.opts.backup != nil {
			if loser, ok := downloaded[id]; ok {
				if err := e.opts.backup("local_wins", loser.note, nil); err != nil {
					e.logger.Console("Sync: failed to backup remote note %s: %v", id, err)
				}
				e.logger.InfoCode(MsgDriveConflictKeepLocal, map[string]interface{}{"noteId": id})
			}
		}
		e.logger.InfoCode(MsgDriveSyncUploadNote, map[string]interface{}{"noteId": id, "current": i + 1, "total": len(uploadIDs)})
		loaded, err := e.notes.LoadNote(id)
		if err != nil {
			report.Failures++
			continue
		}
		note := *loaded
		note.Syncing = false
		note.FolderID = localMeta[id].FolderID // 旧クライアント向けに現在の所属を書く（読み手は noteList を正とする）
		remote := remoteFiles.ByNoteID[id]
		lineage := noteLineage{ParentVersion: remote.Version, Skipped: skippedOf(id)}
		ref, err := e.gateway.UploadNote(layout, &note, remote.FileID, lineage)
		if err != nil {
			if isAuthDriveError(err) {
				return report, false, err
			}
			e.logger.ErrorCode(err, MsgDriveErrorUploadNote, map[string]interface{}{"noteId": id})
			report.Failures++
			continue
		}
		uploaded[id] = uploadedNote{ref: ref, note: &note, hash: computeContentHash(&note), lineage: lineage}
		report.Uploaded++
	}

	remoteDeleted := map[string]bool{}
	for _, id := range ids {
		if decisions[id].Kind != decisionDeleteRemote {
			continue
		}
		ref, ok := remoteFiles.ByNoteID[id]
		if !ok {
			continue
		}
		e.logger.InfoCode(MsgDriveSyncDeleteNote, map[string]interface{}{"noteId": id})
		if err := e.gateway.DeleteFile(ref.FileID); err != nil {
			if isAuthDriveError(err) {
				return report, false, err
			}
			e.logger.ErrorCode(err, MsgDriveErrorDeleteNote, map[string]interface{}{"noteId": id})
			report.Failures++
			continue
		}
		remoteDeleted[id] = true
		report.DeletedRemote++
	}
	for _, fileID := range remoteFiles.DuplicateFileIDs {
		_ = e.gateway.DeleteFile(fileID)
	}

	// ---- 5. ローカルコミット（UI の保存と排他。ネットワーク I/O なし） ----
	remoteMetaByID := map[string]NoteMetadata{}
	if remoteList != nil {
		remoteMetaByID = notesByID(remoteList.Notes)
	}
	applied := map[string]bool{}
	removedLocally := map[string]bool{}
	var recovered []recoveredLocal
	var cloudList *NoteList
	var commitErr error

	e.notes.WithLock(func() {
		current := e.notes.snapshotNoteListLocked()
		currentMeta := notesByID(current.Notes)
		// スナップショット以降にユーザーが触ったノートは、このサイクルでは上書き・削除しない
		untouched := func(id string) bool {
			c, inC := currentMeta[id]
			s, inS := localMeta[id]
			return inC == inS && c.ContentHash == s.ContentHash
		}

		for _, id := range ids {
			d := decisions[id]
			switch d.Kind {
			case decisionApplyRemote:
				dl := downloaded[id]
				if !untouched(id) {
					// 出どころ不明の版からユーザーが編集を続けた: 分けない。base はクラウドの版のままなので、
					// 次の同期でその編集がクラウドの版を上書きする。上書きされる版をここで残す
					if d.RecoverLocal && backupEnabled && e.opts.backup != nil {
						if err := e.opts.backup("local_wins", dl.note, nil); err != nil {
							e.logger.Console("Sync: failed to backup remote note %s: %v", id, err)
						}
						e.logger.InfoCode(MsgDriveConflictKeepLocal, map[string]interface{}{"noteId": id})
					}
					continue
				}
				var fork *Note
				if d.RecoverLocal {
					// 上書きする前に、ローカルの版を新しい ID の別ノート（復帰ノート）として残す。残せなければ上書きしない
					var err error
					if fork, err = e.recoverLocalLocked(id); err != nil {
						e.logger.Console("Sync: failed to keep local note %s as a recovered note: %v", id, err)
						report.Failures++
						continue
					}
				}
				if d.BackupLocal && backupEnabled && e.opts.backup != nil {
					if local, err := e.notes.loadNoteLocked(id); err == nil {
						if err := e.opts.backup("cloud_wins", local, dl.note); err != nil {
							e.logger.Console("Sync: failed to backup local note %s: %v", id, err)
						}
					}
					e.logger.InfoCode(MsgDriveConflictKeepCloud, map[string]interface{}{"noteId": id})
				}
				write := *dl.note
				write.FolderID = ""
				if err := e.notes.saveNoteFromSyncLocked(&write); err != nil {
					e.logger.ErrorCode(err, MsgDriveErrorSaveDownloadedNote, map[string]interface{}{"noteId": id})
					report.Failures++
					if fork != nil {
						_ = e.notes.deleteNoteFromSyncLocked(fork.ID) // 元のノートがローカルの版のままなので分けない
					}
					continue
				}
				if fork != nil {
					recovered = append(recovered, recoveredLocal{originalID: id, note: fork})
				}
				applied[id] = true
				report.LocalChanged = true
			case decisionDeleteLocal:
				if !untouched(id) {
					continue
				}
				if d.BackupLocal && backupEnabled && e.opts.backup != nil {
					if local, err := e.notes.loadNoteLocked(id); err == nil {
						if err := e.opts.backup("cloud_delete", local, nil); err != nil {
							e.logger.Console("Sync: failed to backup local note %s: %v", id, err)
						}
					}
				}
				if err := e.notes.deleteNoteFromSyncLocked(id); err != nil {
					e.logger.ErrorCode(err, MsgDriveErrorRemoveLocalNote, map[string]interface{}{"noteId": id})
					report.Failures++
					continue
				}
				removedLocally[id] = true
				report.DeletedLocal++
				report.LocalChanged = true
			}
		}

		// マージ後にこの端末に存在するノート
		var finals []NoteMetadata
		finalIDs := map[string]bool{}
		for _, meta := range current.Notes {
			if removedLocally[meta.ID] || finalIDs[meta.ID] {
				continue
			}
			up, wasUploaded := uploaded[meta.ID]
			switch {
			case applied[meta.ID]:
				dl := downloaded[meta.ID]
				finals = append(finals, metaOfNote(dl.note, dl.hash))
			case wasUploaded && untouched(meta.ID):
				// 送った本体に合わせる（一覧の記録が本体と食い違っていても、ここで直る）
				finals = append(finals, metaOfNote(up.note, up.hash))
			case verified[meta.ID] != nil && untouched(meta.ID) && decisions[meta.ID].Kind != decisionSkip:
				// 判定できなかったノートの記録は直さない（直すと次からローカルの編集として送ってしまう）
				note := verified[meta.ID]
				finals = append(finals, metaOfNote(note, computeContentHash(note)))
			default:
				finals = append(finals, meta)
			}
			finalIDs[meta.ID] = true
		}
		for _, id := range ids {
			if applied[id] && !finalIDs[id] {
				dl := downloaded[id]
				finals = append(finals, metaOfNote(dl.note, dl.hash))
				finalIDs[id] = true
			}
		}
		for _, r := range recovered {
			finals = append(finals, metaOfNote(r.note, computeContentHash(r.note)))
			finalIDs[r.note.ID] = true
		}
		// Drive には本体があるがローカルに無いノート（ダウンロード失敗など）はクラウドの記載を保つ
		passThrough := map[string]bool{}
		var passMetas []NoteMetadata
		for _, id := range ids {
			if _, onRemote := remoteFiles.ByNoteID[id]; !onRemote || remoteDeleted[id] || finalIDs[id] {
				continue
			}
			if meta, ok := remoteMetaByID[id]; ok {
				passMetas = append(passMetas, meta)
				passThrough[id] = true
			} else if dl, ok := downloaded[id]; ok {
				passMetas = append(passMetas, metaOfNote(dl.note, dl.hash))
				passThrough[id] = true
			}
		}

		merged := mergeNoteList(mergeNoteListInput{
			Base:   base.NoteList,
			Local:  withRecoveredNotes(current, recovered),
			Remote: remoteList,
			Notes:  append(append([]NoteMetadata{}, finals...), passMetas...),
		})

		localResult := withoutNotes(merged, passThrough)
		if !sameNoteList(localResult, current) {
			e.notes.noteList = localResult
			if err := e.notes.saveNoteList(); err != nil {
				commitErr = err
				return
			}
			report.LocalChanged = true
		}

		// クラウド用: 本体が Drive に確定しているノートだけ。メタは Drive 上の本体に合わせる。
		onDrive := func(id string) bool {
			if _, ok := uploaded[id]; ok {
				return true
			}
			_, onRemote := remoteFiles.ByNoteID[id]
			return onRemote && !remoteDeleted[id]
		}
		pending := map[string]bool{}
		for _, n := range merged.Notes {
			if !onDrive(n.ID) {
				pending[n.ID] = true
			}
		}
		cloud := withoutNotes(merged, pending)
		for i, n := range cloud.Notes {
			driveMeta := n
			if up, ok := uploaded[n.ID]; ok {
				driveMeta = metaOfNote(up.note, up.hash)
			} else if dl, ok := downloaded[n.ID]; ok {
				driveMeta = metaOfNote(dl.note, dl.hash)
			} else if snap, ok := localMeta[n.ID]; ok && decisions[n.ID].Kind == decisionNone {
				driveMeta = snap
			} else if rm, ok := remoteMetaByID[n.ID]; ok {
				driveMeta = rm
			}
			driveMeta.FolderID = n.FolderID
			cloud.Notes[i] = driveMeta
		}
		cloudList = cloud
	})
	if commitErr != nil {
		return report, false, fmt.Errorf("failed to save merged note list: %w", commitErr)
	}
	for _, r := range recovered {
		e.state.MarkNoteDirty(r.note.ID)
		e.logger.InfoCode(MsgDriveSyncRecoveredNote, map[string]interface{}{"noteId": r.note.ID, "title": r.note.Title})
	}

	// ---- 6. ノート単位の base（このサイクルで確定した事実）----
	nextBase := base.clone()
	var resolvedDeletions []string
	for _, id := range ids {
		d := decisions[id]
		remote, onRemote := remoteFiles.ByNoteID[id]
		switch d.Kind {
		case decisionNone:
			if l, ok := localState[id]; ok && onRemote {
				nextBase.Notes[id] = syncBaseNote{Hash: l.Hash, Md5: remote.Md5, FileID: remote.FileID, Version: remote.Version, Skipped: skippedOf(id)}
			}
		case decisionUpload:
			if up, ok := uploaded[id]; ok {
				// 書き込みまでの間に見ずに上書きした版も含める（他端末が読むときと同じ計算）
				nextBase.Notes[id] = syncBaseNote{
					Hash: up.hash, Md5: up.ref.Md5, FileID: up.ref.FileID, Version: up.ref.Version,
					Skipped: knownSkippedVersions(up.lineage.Skipped, up.lineage.ParentVersion, up.ref.Version),
				}
			}
		case decisionApplyRemote:
			if applied[id] && onRemote {
				nextBase.Notes[id] = syncBaseNote{Hash: downloaded[id].hash, Md5: remote.Md5, FileID: remote.FileID, Version: remote.Version, Skipped: skippedOf(id)}
				if deletedIDs[id] {
					resolvedDeletions = append(resolvedDeletions, id) // 削除の取り消し
				}
			}
		case decisionDeleteLocal:
			if removedLocally[id] {
				delete(nextBase.Notes, id)
			}
		case decisionDeleteRemote:
			if remoteDeleted[id] {
				delete(nextBase.Notes, id)
				resolvedDeletions = append(resolvedDeletions, id)
			}
		case decisionForget:
			delete(nextBase.Notes, id)
			if deletedIDs[id] {
				resolvedDeletions = append(resolvedDeletions, id)
			}
		}
	}

	// 削除意図の対象がローカルに存在する（同期で復元された等）なら、その意図はもう無効
	for id := range deletedIDs {
		if _, ok := localState[id]; ok && !containsString(resolvedDeletions, id) {
			resolvedDeletions = append(resolvedDeletions, id)
		}
	}

	// checkpoint はこのサイクルで確定した事実（ノート単位の base・処理済みの削除意図）を保存する。
	// やり直し・中断のときに使う。noteList の base は「ローカルに取り込み済みのクラウドの版」。
	checkpoint := func(ref *remoteFileRef, list *NoteList) error {
		nextBase.RootFolderID = layout.RootFolderID
		nextBase.NoteListFileID = refFileID(ref)
		nextBase.NoteListMd5 = refMd5(ref)
		nextBase.NoteList = list
		if err := e.saveBase(nextBase); err != nil {
			return err
		}
		e.state.CompleteSync(revision, resolvedDeletions, false)
		e.notifyLocalChange(report)
		return nil
	}

	// ---- 7. noteList のアップロード ----
	newListRef := listRef
	newBaseList := remoteList
	if remoteList == nil || !sameNoteList(cloudList, remoteList) {
		retry, err := func() (bool, error) {
			latest, err := e.gateway.FindNoteList(layout)
			if err != nil {
				return false, err
			}
			if refFileID(latest) != refFileID(listRef) || refMd5(latest) != refMd5(listRef) {
				// 読み取り後に他端末が noteList を書いた。ローカルは remoteList を取り込み済みなので
				// それを base として確定し、最初からやり直す（相手の書き込みを上書きしない）。
				return true, checkpoint(listRef, remoteList)
			}
			ref, err := e.gateway.UploadNoteList(layout, refFileID(listRef), cloudList)
			if err != nil {
				return false, err
			}
			newListRef = &ref
			newBaseList = cloudList
			report.ListUploaded = true
			// 確認から書き込みまでの間に他端末が書いていた（版が 2 以上進んだ）場合は相手の noteList を
			// 上書きしている。相手のノート本体は Drive に残っているので、すぐにもう一度同期して取り戻す。
			if listRef != nil && listRef.Version > 0 && ref.Version > listRef.Version+1 {
				return true, checkpoint(&ref, cloudList)
			}
			// noteList を新規作成した場合、同時に別端末も作っていないか確認する（最古が正）。
			// 自分のものが最古でなければ削除し、最古の noteList を相手にやり直す。
			if listRef == nil {
				oldest, err := e.gateway.FindNoteList(layout)
				if err == nil && oldest != nil && oldest.FileID != ref.FileID {
					_ = e.gateway.DeleteFile(ref.FileID)
					return true, checkpoint(nil, nil)
				}
			}
			return false, nil
		}()
		if err != nil {
			// noteList の書き込みに失敗しても、ノート単位で確定した事実は失わない
			if cpErr := checkpoint(listRef, remoteList); cpErr != nil {
				e.logger.Console("Sync: failed to save checkpoint: %v", cpErr)
			}
			return report, false, err
		}
		if retry {
			return report, true, nil
		}
	}

	// ---- 8. base 更新と後始末 ----
	nextBase.RootFolderID = layout.RootFolderID
	nextBase.NoteListFileID = refFileID(newListRef)
	nextBase.NoteListMd5 = refMd5(newListRef)
	nextBase.NoteList = newBaseList
	if err := e.saveBase(nextBase); err != nil {
		return report, false, err
	}
	e.state.CompleteSync(revision, resolvedDeletions, report.Failures == 0)
	e.notifyLocalChange(report)
	if report.Failures == 0 {
		e.verifiedAll = true
	}
	// 復帰ノートはローカルにだけある。続けてもう一度同期して Drive に送る
	return report, len(recovered) > 0, nil
}

// recoverLocalLocked はローカルの版を新しい ID の別ノート（復帰ノート）として保存する（noteService のロック内）。
// noteList への登録はマージで行う（withRecoveredNotes）。
func (e *syncEngine) recoverLocalLocked(id string) (*Note, error) {
	local, err := e.notes.loadNoteLocked(id)
	if err != nil {
		return nil, err
	}
	fork := *local
	fork.ID = uuid.New().String()
	fork.Title = e.recoveredTitle(local.Title)
	fork.ContentHeader = generateContentHeader(fork.Content)
	fork.FolderID = ""
	fork.Syncing = false
	if err := e.notes.saveNoteFromSyncLocked(&fork); err != nil {
		return nil, err
	}
	return &fork, nil
}

func (e *syncEngine) recoveredTitle(title string) string {
	if e.opts.recoveredTitle != nil {
		return e.opts.recoveredTitle(title)
	}
	return recoveredNoteTitle(title, LocaleEnglish)
}

// withRecoveredNotes は復帰ノートを元のノートのすぐ下（同じフォルダ / 同じ系列）に置いた noteList のコピーを返す。
// マージの local 側に使う（base にも remote にも無いので「ローカルで追加した位置」がそのまま残る）。
func withRecoveredNotes(list *NoteList, recovered []recoveredLocal) *NoteList {
	if len(recovered) == 0 {
		return list
	}
	out := *list
	out.Notes = append([]NoteMetadata{}, list.Notes...)
	out.TopLevelOrder = append([]TopLevelItem{}, list.TopLevelOrder...)
	out.ArchivedTopLevelOrder = append([]TopLevelItem{}, list.ArchivedTopLevelOrder...)
	for _, r := range recovered {
		meta := metaOfNote(r.note, computeContentHash(r.note))
		at := len(out.Notes)
		for i, m := range out.Notes {
			if m.ID == r.originalID {
				meta.FolderID = m.FolderID
				at = i + 1
				break
			}
		}
		out.Notes = append(out.Notes[:at], append([]NoteMetadata{meta}, out.Notes[at:]...)...)
		if meta.FolderID != "" {
			continue
		}
		item := TopLevelItem{Type: "note", ID: meta.ID}
		if meta.Archived {
			out.ArchivedTopLevelOrder = insertNoteItemAfter(out.ArchivedTopLevelOrder, r.originalID, item)
		} else {
			out.TopLevelOrder = insertNoteItemAfter(out.TopLevelOrder, r.originalID, item)
		}
	}
	return &out
}

// insertNoteItemAfter は順序の中で afterID のノートの直後に item を入れる（見つからなければ先頭）。
func insertNoteItemAfter(order []TopLevelItem, afterID string, item TopLevelItem) []TopLevelItem {
	for i, it := range order {
		if it.Type == "note" && it.ID == afterID {
			return append(order[:i+1], append([]TopLevelItem{item}, order[i+1:]...)...)
		}
	}
	return append([]TopLevelItem{item}, order...)
}

func (e *syncEngine) notifyLocalChange(report syncReport) {
	if report.LocalChanged {
		e.logger.NotifyFrontendSyncedAndReload(e.ctx)
	}
}

// effectiveBase は今回のサイクルで使う base。Drive（アカウント）が変わった / noteList が消えた場合は
// 破棄して「和集合」で安全に同期し直す。v2 からの移行時は旧 LastSyncedNoteHash を使う。
func (e *syncEngine) effectiveBase(layout driveLayoutIDs, listRef *remoteFileRef) *SyncBase {
	stored := e.loadBase()
	fresh := emptySyncBase(layout.RootFolderID)
	if stored == nil {
		if listRef == nil {
			return fresh
		}
		for id, hash := range e.state.LegacyNoteHashes() {
			fresh.Notes[id] = syncBaseNote{Hash: hash}
		}
		return fresh
	}
	if stored.RootFolderID != layout.RootFolderID || listRef == nil {
		return fresh
	}
	if stored.NoteListFileID != "" && stored.NoteListFileID != listRef.FileID {
		cp := stored.clone()
		cp.NoteList = nil
		cp.NoteListFileID = ""
		cp.NoteListMd5 = ""
		return cp
	}
	return stored
}

func (e *syncEngine) loadBase() *SyncBase {
	if !e.baseLoaded {
		e.baseCache = e.baseStore.Load()
		e.baseLoaded = true
	}
	return e.baseCache
}

func (e *syncEngine) saveBase(base *SyncBase) error {
	if err := e.baseStore.Save(base); err != nil {
		return err
	}
	e.baseCache = base
	e.baseLoaded = true
	return nil
}

func containsString(values []string, target string) bool {
	for _, v := range values {
		if v == target {
			return true
		}
	}
	return false
}

func refFileID(ref *remoteFileRef) string {
	if ref == nil {
		return ""
	}
	return ref.FileID
}

func refMd5(ref *remoteFileRef) string {
	if ref == nil {
		return ""
	}
	return ref.Md5
}

// metaOfNote は本体から noteList 用のメタを作る（FolderID は呼び出し側で決める）。
func metaOfNote(note *Note, hash string) NoteMetadata {
	header := note.ContentHeader
	if header == "" {
		header = generateContentHeader(note.Content)
	}
	return NoteMetadata{
		ID:            note.ID,
		Title:         note.Title,
		ContentHeader: header,
		Language:      note.Language,
		ModifiedTime:  note.ModifiedTime,
		Archived:      note.Archived,
		ContentHash:   hash,
	}
}

// withoutNotes は noteList からノートを取り除いたコピーを返す（残りの相対順序は変えない）。
func withoutNotes(list *NoteList, ids map[string]bool) *NoteList {
	out := &NoteList{
		Version:               list.Version,
		Notes:                 []NoteMetadata{},
		Folders:               append([]Folder{}, list.Folders...),
		TopLevelOrder:         []TopLevelItem{},
		ArchivedTopLevelOrder: []TopLevelItem{},
		CollapsedFolderIDs:    append([]string{}, list.CollapsedFolderIDs...),
	}
	for _, n := range list.Notes {
		if !ids[n.ID] {
			out.Notes = append(out.Notes, n)
		}
	}
	keep := func(item TopLevelItem) bool { return !(item.Type == "note" && ids[item.ID]) }
	for _, item := range list.TopLevelOrder {
		if keep(item) {
			out.TopLevelOrder = append(out.TopLevelOrder, item)
		}
	}
	for _, item := range list.ArchivedTopLevelOrder {
		if keep(item) {
			out.ArchivedTopLevelOrder = append(out.ArchivedTopLevelOrder, item)
		}
	}
	return out
}
