package backend

import (
	"math"
	"regexp"
	"sort"
	"time"
)

// 同期エンジン v3 の純粋コア（docs/sync-engine-v3.md §6, §7）。
//
// ネットワーク・ファイル I/O を一切持たない純粋関数だけを置く。
// モバイル版 mobile/src/services/sync/core/*.ts と完全一致させること。
// 一致は共有ベクター sync-spec/vectors/*.json（sync_core_vectors_test.go）で検証する。

// ------------------------------------------------------------
// ノート単位の判定 (§6)
// ------------------------------------------------------------

type noteSideState struct {
	Hash         string `json:"hash"`
	ModifiedTime string `json:"modifiedTime"`
	// ParentVersion はダウンロードした版を書いた端末が置き換えた Drive の版番号（= その端末が見ていた版）。
	// 旧クライアントの書き込みには無い（0）。ローカル側では使わない。
	ParentVersion int64 `json:"parentVersion,omitempty"`
	// Skipped は本体の syncSkipped（履歴の中で見ずに上書きされた版番号の範囲）。ローカル側では使わない。
	Skipped []versionRange `json:"skipped,omitempty"`
}

type baseNoteState struct {
	Hash    string `json:"hash"`
	Md5     string `json:"md5,omitempty"`
	FileID  string `json:"fileId,omitempty"`
	Version int64  `json:"version,omitempty"` // 前回同期時の Drive の版番号
}

type remoteNoteState struct {
	Md5     string `json:"md5"`
	FileID  string `json:"fileId,omitempty"`
	Version int64  `json:"version,omitempty"` // 一覧で分かる Drive の版番号
}

// decideNoteInput の Downloaded を nil で呼ぶのがフェーズ1、ダウンロード結果を入れて呼ぶのがフェーズ2。
type decideNoteInput struct {
	Local        *noteSideState   `json:"local,omitempty"`      // ローカルに存在する（本体が読める）
	LocalDeleted bool             `json:"localDeleted"`         // ユーザー操作で削除が記録されている
	Base         *baseNoteState   `json:"base,omitempty"`       // 前回同期時点（md5 は欠けうる）
	Remote       *remoteNoteState `json:"remote,omitempty"`     // Drive に本体ファイルがある
	Downloaded   *noteSideState   `json:"downloaded,omitempty"` // フェーズ2のダウンロード結果
}

type decisionKind string

const (
	decisionNone         decisionKind = "none"
	decisionDownload     decisionKind = "download"
	decisionUpload       decisionKind = "upload"
	decisionApplyRemote  decisionKind = "applyRemote"
	decisionDeleteLocal  decisionKind = "deleteLocal"
	decisionDeleteRemote decisionKind = "deleteRemote"
	decisionForget       decisionKind = "forget"
)

type noteDecision struct {
	Kind        decisionKind
	BackupLocal bool // applyRemote / deleteLocal: 上書き・削除する前にローカルの版を残す
	// BackupRemote は upload で、真の競合でローカルが勝った。負けたリモートの版を勝った端末に残す。
	BackupRemote bool
}

func decideNote(in decideNoteInput) noteDecision {
	local, base, remote, downloaded := in.Local, in.Base, in.Remote, in.Downloaded

	if local == nil {
		if in.LocalDeleted {
			if remote == nil {
				return noteDecision{Kind: decisionForget}
			}
			if base == nil {
				return noteDecision{Kind: decisionDeleteRemote}
			}
			if base.Md5 != "" && remote.Md5 == base.Md5 {
				return noteDecision{Kind: decisionDeleteRemote}
			}
			if downloaded == nil {
				return noteDecision{Kind: decisionDownload}
			}
			// 編集は削除に勝つ（P4）: 相手が編集していたら削除を取り消して復元する
			if downloaded.Hash == base.Hash {
				return noteDecision{Kind: decisionDeleteRemote}
			}
			return noteDecision{Kind: decisionApplyRemote}
		}
		if remote != nil {
			if downloaded != nil {
				return noteDecision{Kind: decisionApplyRemote}
			}
			return noteDecision{Kind: decisionDownload}
		}
		return noteDecision{Kind: decisionForget}
	}

	if remote == nil {
		// 新規 or ローカル編集あり → 編集は削除に勝つ
		if base == nil || local.Hash != base.Hash {
			return noteDecision{Kind: decisionUpload}
		}
		return noteDecision{Kind: decisionDeleteLocal, BackupLocal: true}
	}

	if base != nil && base.Md5 != "" && remote.Md5 == base.Md5 {
		if local.Hash == base.Hash {
			return noteDecision{Kind: decisionNone}
		}
		return noteDecision{Kind: decisionUpload}
	}

	if downloaded == nil {
		return noteDecision{Kind: decisionDownload}
	}
	if downloaded.Hash == local.Hash {
		return noteDecision{Kind: decisionNone}
	}

	localChanged := base == nil || local.Hash != base.Hash
	if !localChanged {
		// ファイルが作り直されている = 一度削除され、編集が勝って復元された（P4）。削除より後の出来事なので
		// 時刻にかかわらず取り込む。手元の版は削除されたもので、他端末でのリモート削除と同じく残しておく。
		if base != nil && base.FileID != "" && remote.FileID != "" && base.FileID != remote.FileID {
			return noteDecision{Kind: decisionApplyRemote, BackupLocal: true}
		}
		// 同じファイルなのに手元（未変更）よりリモートの方が古い = 別端末が古い判断で上書きした
		// （ノート本体の lost update）。最新の版（手元）を送り直し、上書きしてきた版は残す
		// （その端末のユーザーは手元の版を見ずに編集したので、黙って捨てない）。
		if isAfterRFC3339(local.ModifiedTime, downloaded.ModifiedTime) {
			return noteDecision{Kind: decisionUpload, BackupRemote: true}
		}
		// リモートの方が新しい = 通常は更新として取り込むだけ。ただし手元の版が、リモートの版の履歴の中で
		// 見ずに上書きされていれば（同期の入れ違い。何段重なっていても syncSkipped に残る）、手元の版も残す。
		// 勝敗は変えず（新しい方が勝つ）、バックアップを増やすだけに使う。
		skipped := knownSkippedVersions(downloaded.Skipped, downloaded.ParentVersion, remote.Version)
		blind := base != nil && base.Version > 0 && skippedVersionsContain(skipped, base.Version)
		return noteDecision{Kind: decisionApplyRemote, BackupLocal: blind}
	}
	// md5 だけ変わって中身は base のまま（別端末の再シリアライズ）→ ローカルの変更を送る
	if base != nil && downloaded.Hash == base.Hash {
		return noteDecision{Kind: decisionUpload}
	}
	if isAfterRFC3339(local.ModifiedTime, downloaded.ModifiedTime) {
		return noteDecision{Kind: decisionUpload, BackupRemote: true}
	}
	return noteDecision{Kind: decisionApplyRemote, BackupLocal: true}
}

// Go の time.RFC3339 が受け付ける形（T / Z は大文字、秒の小数は任意）。
// モバイル版の正規表現と同じ形だけを「時刻」として扱う。
var rfc3339Pattern = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$`)

// isAfterRFC3339 は a が b より新しいか。両方 RFC3339 なら時刻で、そうでなければ文字列で比較する。
// 同時刻は false（= リモート勝ち）。
func isAfterRFC3339(a, b string) bool {
	ta, okA := parseRFC3339Strict(a)
	tb, okB := parseRFC3339Strict(b)
	if okA && okB {
		return ta.After(tb)
	}
	return a > b
}

func parseRFC3339Strict(v string) (time.Time, bool) {
	if !rfc3339Pattern.MatchString(v) {
		return time.Time{}, false
	}
	t, err := time.Parse(time.RFC3339, v)
	if err != nil {
		return time.Time{}, false
	}
	// モバイル (Date.parse) はミリ秒精度なので揃える
	return t.Truncate(time.Millisecond), true
}

// ------------------------------------------------------------
// 順序の 3-way マージ (§7.2)
// ------------------------------------------------------------

// mergeSequence は base/local/remote の 3 つのキー列をマージする。
// hasBase=false（移行直後など）のときは local ∩ remote（local の順）を base とみなす。
func mergeSequence(base []string, hasBase bool, local, remote []string) []string {
	localU := dedupeStrings(local)
	remoteU := dedupeStrings(remote)
	var baseU []string
	if hasBase {
		baseU = dedupeStrings(base)
	} else {
		remoteSet := stringSet(remoteU)
		for _, k := range localU {
			if remoteSet[k] {
				baseU = append(baseU, k)
			}
		}
	}

	localSet := stringSet(localU)
	baseSet := stringSet(baseU)
	result := make([]string, 0, len(remoteU)+len(localU))
	for _, k := range remoteU {
		if baseSet[k] && !localSet[k] {
			continue // ローカルで除いた
		}
		result = append(result, k)
	}

	stable := stringSet(lcsStrings(baseU, localU))
	for j, key := range localU {
		if stable[key] {
			continue
		}
		if idx := indexOfString(result, key); idx >= 0 {
			result = append(result[:idx], result[idx+1:]...)
		}
		insertAt := 0
		for p := j - 1; p >= 0; p-- {
			if anchor := indexOfString(result, localU[p]); anchor >= 0 {
				insertAt = anchor + 1
				break
			}
		}
		result = append(result, "")
		copy(result[insertAt+1:], result[insertAt:])
		result[insertAt] = key
	}
	return result
}

// lcsStrings は決定的な LCS（接尾辞 DP、同長のときは a 側を進める）。
func lcsStrings(a, b []string) []string {
	n, m := len(a), len(b)
	table := make([][]int, n+1)
	for i := range table {
		table[i] = make([]int, m+1)
	}
	for i := n - 1; i >= 0; i-- {
		for j := m - 1; j >= 0; j-- {
			if a[i] == b[j] {
				table[i][j] = table[i+1][j+1] + 1
			} else if table[i+1][j] >= table[i][j+1] {
				table[i][j] = table[i+1][j]
			} else {
				table[i][j] = table[i][j+1]
			}
		}
	}
	var out []string
	i, j := 0, 0
	for i < n && j < m {
		switch {
		case a[i] == b[j]:
			out = append(out, a[i])
			i++
			j++
		case table[i+1][j] >= table[i][j+1]:
			i++
		default:
			j++
		}
	}
	return out
}

// ------------------------------------------------------------
// 構造の 3-way マージ (§7)
// ------------------------------------------------------------

// mergeNoteListInput の Notes はマージ後に存在するノートの最終メタ（FolderID は無視される）。
// Base が nil のときは「両側にある項目はローカルでは変更されていない」とみなす。Remote が nil なら空扱い。
type mergeNoteListInput struct {
	Base   *NoteList
	Local  *NoteList
	Remote *NoteList
	Notes  []NoteMetadata
}

func mergeNoteList(in mergeNoteListInput) *NoteList {
	base := in.Base
	local := in.Local
	if local == nil {
		local = &NoteList{}
	}
	remote := in.Remote
	if remote == nil {
		remote = &NoteList{}
	}

	var finals []NoteMetadata
	finalByID := map[string]NoteMetadata{}
	for _, n := range in.Notes {
		if _, dup := finalByID[n.ID]; dup {
			continue
		}
		n.FolderID = ""
		finalByID[n.ID] = n
		finals = append(finals, n)
	}

	// ---- フォルダ（候補と属性） ----
	var baseFolderList []Folder
	if base != nil {
		baseFolderList = base.Folders
	}
	baseFolders := foldersByID(baseFolderList)
	localFolders := foldersByID(local.Folders)
	remoteFolders := foldersByID(remote.Folders)
	baseFolderOf := func(id string) (Folder, bool) {
		if base != nil {
			f, ok := baseFolders[id]
			return f, ok
		}
		if _, ok := remoteFolders[id]; ok {
			f, okL := localFolders[id]
			return f, okL
		}
		return Folder{}, false
	}

	var candidateIDs []string
	for _, f := range remote.Folders {
		candidateIDs = append(candidateIDs, f.ID)
	}
	for _, f := range local.Folders {
		candidateIDs = append(candidateIDs, f.ID)
	}
	for _, f := range baseFolderList {
		candidateIDs = append(candidateIDs, f.ID)
	}
	candidateIDs = dedupeStrings(candidateIDs)

	type folderCandidate struct {
		folder  Folder
		present bool
	}
	candidates := make([]folderCandidate, 0, len(candidateIDs))
	for _, id := range candidateIDs {
		b, inB := baseFolderOf(id)
		l, inL := localFolders[id]
		r, inR := remoteFolders[id]
		folder := Folder{
			ID:       id,
			Name:     pick3String(b.Name, inB, l.Name, inL, r.Name, inR),
			Archived: pick3Bool(b.Archived, inB, l.Archived, inL, r.Archived, inR),
		}
		var present bool
		switch {
		case inL && inR:
			present = true
		case inL:
			present = !inB || l.Name != b.Name || l.Archived != b.Archived
		case inR:
			present = !inB
		}
		candidates = append(candidates, folderCandidate{folder: folder, present: present})
	}

	// ---- ノートの所属 ----
	var baseNotes map[string]NoteMetadata
	if base != nil {
		baseNotes = notesByID(base.Notes)
	}
	localNotes := notesByID(local.Notes)
	remoteNotes := notesByID(remote.Notes)
	folderIDOf := make(map[string]string, len(finals))
	for _, n := range finals {
		l, inL := localNotes[n.ID]
		r, inR := remoteNotes[n.ID]
		var b NoteMetadata
		var inB bool
		if base != nil {
			b, inB = baseNotes[n.ID]
		} else {
			b, inB = l, inL
		}
		var chosen string
		switch {
		case inL && (!inB || l.FolderID != b.FolderID):
			chosen = l.FolderID
		case inR:
			chosen = r.FolderID
		case inL:
			chosen = l.FolderID
		case inB:
			chosen = b.FolderID
		}
		folderIDOf[n.ID] = chosen
	}

	// 最終ノートが所属しているフォルダは復活させる（編集は削除に勝つ）
	referenced := map[string]bool{}
	for _, fid := range folderIDOf {
		if fid != "" {
			referenced[fid] = true
		}
	}
	folders := []Folder{}
	for _, c := range candidates {
		if c.present || referenced[c.folder.ID] {
			folders = append(folders, c.folder)
		}
	}
	folderByID := foldersByID(folders)

	for _, n := range finals {
		fid := folderIDOf[n.ID]
		if fid != "" {
			folder, ok := folderByID[fid]
			// アーカイブ状態がフォルダと食い違うノート（例: フォルダごとアーカイブ vs 他端末の編集）は
			// トップレベルへ出す。アクティブなノートがアーカイブ済みフォルダにあると、どの画面にも出ない
			if !ok || n.Archived != folder.Archived {
				fid = ""
			}
		}
		folderIDOf[n.ID] = fid
	}

	// ---- notes 配列（フォルダ内の表示順） ----
	var baseNoteIDs []string
	if base != nil {
		baseNoteIDs = noteIDsOf(base.Notes)
	}
	noteSeq := []string{}
	for _, id := range mergeSequence(baseNoteIDs, base != nil, noteIDsOf(local.Notes), noteIDsOf(remote.Notes)) {
		if _, ok := finalByID[id]; ok {
			noteSeq = append(noteSeq, id)
		}
	}
	placedNotes := stringSet(noteSeq)
	var unplaced []NoteMetadata
	for _, n := range finals {
		if !placedNotes[n.ID] {
			unplaced = append(unplaced, n)
		}
	}
	notes := []NoteMetadata{}
	for _, n := range sortNewestFirst(unplaced) {
		n.FolderID = folderIDOf[n.ID]
		notes = append(notes, n)
	}
	for _, id := range noteSeq {
		n := finalByID[id]
		n.FolderID = folderIDOf[id]
		notes = append(notes, n)
	}

	// ---- トップレベル順序（アクティブ / アーカイブ） ----
	buildOrder := func(archived bool, pick func(*NoteList) []TopLevelItem) []TopLevelItem {
		isValid := func(key string) bool {
			item := itemFromKey(key)
			if item.Type == "folder" {
				f, ok := folderByID[item.ID]
				return ok && f.Archived == archived
			}
			n, ok := finalByID[item.ID]
			return ok && n.Archived == archived && folderIDOf[item.ID] == ""
		}
		var baseKeys []string
		if base != nil {
			baseKeys = keysOf(pick(base))
		}
		merged := []string{}
		for _, key := range mergeSequence(baseKeys, base != nil, keysOf(pick(local)), keysOf(pick(remote))) {
			if isValid(key) {
				merged = append(merged, key)
			}
		}
		placed := stringSet(merged)
		var missingFolderIDs []string
		for _, f := range folders {
			if f.Archived == archived && !placed["f:"+f.ID] {
				missingFolderIDs = append(missingFolderIDs, f.ID)
			}
		}
		sort.Strings(missingFolderIDs)
		var missingNotes []NoteMetadata
		for _, n := range finals {
			if n.Archived == archived && folderIDOf[n.ID] == "" && !placed["n:"+n.ID] {
				missingNotes = append(missingNotes, n)
			}
		}
		order := []TopLevelItem{}
		for _, id := range missingFolderIDs {
			order = append(order, TopLevelItem{Type: "folder", ID: id})
		}
		for _, n := range sortNewestFirst(missingNotes) {
			order = append(order, TopLevelItem{Type: "note", ID: n.ID})
		}
		for _, key := range merged {
			order = append(order, itemFromKey(key))
		}
		return order
	}
	topLevelOrder := buildOrder(false, func(l *NoteList) []TopLevelItem { return l.TopLevelOrder })
	archivedTopLevelOrder := buildOrder(true, func(l *NoteList) []TopLevelItem { return l.ArchivedTopLevelOrder })

	// ---- 折りたたみ状態（集合の 3-way） ----
	localCollapsed := dedupeStrings(local.CollapsedFolderIDs)
	remoteCollapsed := dedupeStrings(remote.CollapsedFolderIDs)
	var baseCollapsed map[string]bool
	if base != nil {
		baseCollapsed = stringSet(base.CollapsedFolderIDs)
	} else {
		remoteSet := stringSet(remoteCollapsed)
		baseCollapsed = map[string]bool{}
		for _, id := range localCollapsed {
			if remoteSet[id] {
				baseCollapsed[id] = true
			}
		}
	}
	localSet := stringSet(localCollapsed)
	var collapsedCandidates []string
	for _, id := range remoteCollapsed {
		if baseCollapsed[id] && !localSet[id] {
			continue // ローカルで展開した
		}
		collapsedCandidates = append(collapsedCandidates, id)
	}
	for _, id := range localCollapsed {
		if !baseCollapsed[id] {
			collapsedCandidates = append(collapsedCandidates, id)
		}
	}
	collapsed := []string{}
	for _, id := range dedupeStrings(collapsedCandidates) {
		if _, ok := folderByID[id]; ok {
			collapsed = append(collapsed, id)
		}
	}

	return &NoteList{
		Version:               CurrentVersion,
		Notes:                 notes,
		Folders:               folders,
		TopLevelOrder:         topLevelOrder,
		ArchivedTopLevelOrder: archivedTopLevelOrder,
		CollapsedFolderIDs:    collapsed,
	}
}

// pick3 は local が base から変わっていれば local、そうでなければ remote（無ければ local → base）。
func pick3String(b string, inB bool, l string, inL bool, r string, inR bool) string {
	switch {
	case inL && (!inB || l != b):
		return l
	case inR:
		return r
	case inL:
		return l
	default:
		return b
	}
}

func pick3Bool(b bool, inB bool, l bool, inL bool, r bool, inR bool) bool {
	switch {
	case inL && (!inB || l != b):
		return l
	case inR:
		return r
	case inL:
		return l
	default:
		return b
	}
}

// sortNewestFirst は modifiedTime の新しい順、同時刻は id 昇順に並べる。
func sortNewestFirst(items []NoteMetadata) []NoteMetadata {
	out := append([]NoteMetadata(nil), items...)
	sort.SliceStable(out, func(i, j int) bool {
		if isAfterRFC3339(out[i].ModifiedTime, out[j].ModifiedTime) {
			return true
		}
		if isAfterRFC3339(out[j].ModifiedTime, out[i].ModifiedTime) {
			return false
		}
		return out[i].ID < out[j].ID
	})
	return out
}

func itemKey(item TopLevelItem) string {
	if item.Type == "folder" {
		return "f:" + item.ID
	}
	return "n:" + item.ID
}

func itemFromKey(key string) TopLevelItem {
	if len(key) >= 2 && key[:2] == "f:" {
		return TopLevelItem{Type: "folder", ID: key[2:]}
	}
	return TopLevelItem{Type: "note", ID: key[2:]}
}

func keysOf(items []TopLevelItem) []string {
	out := make([]string, 0, len(items))
	for _, item := range items {
		out = append(out, itemKey(item))
	}
	return out
}

func noteIDsOf(notes []NoteMetadata) []string {
	out := make([]string, 0, len(notes))
	for _, n := range notes {
		out = append(out, n.ID)
	}
	return out
}

func notesByID(notes []NoteMetadata) map[string]NoteMetadata {
	out := make(map[string]NoteMetadata, len(notes))
	for _, n := range notes {
		if _, dup := out[n.ID]; !dup {
			out[n.ID] = n
		}
	}
	return out
}

func foldersByID(folders []Folder) map[string]Folder {
	out := make(map[string]Folder, len(folders))
	for _, f := range folders {
		if _, dup := out[f.ID]; !dup {
			out[f.ID] = f
		}
	}
	return out
}

func dedupeStrings(values []string) []string {
	seen := make(map[string]bool, len(values))
	out := make([]string, 0, len(values))
	for _, v := range values {
		if seen[v] {
			continue
		}
		seen[v] = true
		out = append(out, v)
	}
	return out
}

func stringSet(values []string) map[string]bool {
	out := make(map[string]bool, len(values))
	for _, v := range values {
		out[v] = true
	}
	return out
}

func indexOfString(values []string, target string) int {
	for i, v := range values {
		if v == target {
			return i
		}
	}
	return -1
}

// ---- 見ずに上書きされた版番号の範囲（docs/sync-engine-v3.md §6） ----
//
// ノート本体の書き込みは、置き換えた版番号（syncParentVersion）と、履歴の中で見ずに上書きされた版番号の
// 範囲（syncSkipped）を持つ。自分の版番号がこの範囲に入っていれば、その版は誰にも見られずに消えている。
// モバイル版 core/skippedVersions.ts と 1:1（sync-spec/vectors/skipped-versions.json で検証）。

// versionRange は [from, to]（両端を含む）。JSON では [from, to] の配列になる。
type versionRange [2]int64

// maxSkippedVersionRanges は本体に持たせる範囲の上限。超えたら番号の小さい（古い）方から捨てる。
const maxSkippedVersionRanges = 32

// normalizeSkippedVersions は不正な範囲を除き、昇順に並べて重なり・隣接をまとめ、上限を超えた古い範囲を捨てる。
func normalizeSkippedVersions(ranges []versionRange) []versionRange {
	valid := make([]versionRange, 0, len(ranges))
	for _, r := range ranges {
		if r[0] >= 1 && r[0] <= r[1] {
			valid = append(valid, r)
		}
	}
	sort.Slice(valid, func(i, j int) bool {
		if valid[i][0] != valid[j][0] {
			return valid[i][0] < valid[j][0]
		}
		return valid[i][1] < valid[j][1]
	})
	merged := []versionRange{}
	for _, r := range valid {
		if n := len(merged); n > 0 && r[0] <= merged[n-1][1]+1 {
			if r[1] > merged[n-1][1] {
				merged[n-1][1] = r[1]
			}
			continue
		}
		merged = append(merged, r)
	}
	if len(merged) > maxSkippedVersionRanges {
		merged = merged[len(merged)-maxSkippedVersionRanges:]
	}
	return merged
}

// knownSkippedVersions はある版の「履歴の中で見ずに上書きされた版番号」: 本体の syncSkipped に、その版自身が
// 見ずに上書きした範囲 (parentVersion, version)（両端を含まない）を加えたもの。parentVersion が 0
// （旧クライアントの書き込み）なら加えない。version が 0（不明）なら上端を決められないので、
// parentVersion より後をすべて含める。
func knownSkippedVersions(skipped []versionRange, parentVersion, version int64) []versionRange {
	ranges := append([]versionRange{}, skipped...)
	if parentVersion > 0 {
		upper := int64(math.MaxInt64)
		if version > 0 {
			upper = version - 1
		}
		if upper >= parentVersion+1 {
			ranges = append(ranges, versionRange{parentVersion + 1, upper})
		}
	}
	return normalizeSkippedVersions(ranges)
}

func skippedVersionsContain(ranges []versionRange, version int64) bool {
	for _, r := range ranges {
		if r[0] <= version && version <= r[1] {
			return true
		}
	}
	return false
}
