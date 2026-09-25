package backend

import (
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"testing"
	"time"

	"google.golang.org/api/drive/v3"
	"google.golang.org/api/option"
)

// fakeDrive は Google Drive REST v3 (appDataFolder) の忠実な in-memory 実装。
//
//   - httptest.Server として動くので、本番の driveOperationsImpl (google-api-go-client)
//     をそのまま通せる。fields 指定・multipart アップロード・エラーレスポンスまで検証対象。
//   - fileId / md5Checksum (実バイトの md5) / version / modifiedTime (論理時計) /
//     Changes フィード / 同名ファイルの重複 を Drive と同じ意味論で持つ。
//   - リクエストヘッダ X-Fake-Device で端末を識別し、端末ごとの割り込みフックと
//     障害注入ができる。レースを実時間の運ではなく決定的に再現するための仕組み。
//
// モバイル側の mobile/src/test/fakeDrive.ts と同じ意味論を持つ。
type fakeDrive struct {
	mu       sync.Mutex
	files    map[string]*fakeFile
	changes  []fakeChange
	idSeq    int
	clock    time.Time
	requests []fakeRequest
	hooks    []*fakeHook
	failures []*fakeFailure
	server   *httptest.Server
}

type fakeFile struct {
	ID           string
	Name         string
	MimeType     string
	Parents      []string
	Content      []byte
	Md5          string
	Version      int64
	CreatedTime  string
	ModifiedTime string
}

type fakeChange struct {
	FileID  string
	Removed bool
}

type fakeRequest struct {
	Op       string // files.list / files.get / files.download / files.create / files.update / files.delete / changes.getStartPageToken / changes.list
	Device   string
	FileID   string
	FileName string
	Query    string
}

type fakeHook struct {
	match     func(fakeRequest) bool
	run       func(fakeRequest)
	remaining int
}

type fakeFailure struct {
	match     func(fakeRequest) bool
	status    int
	remaining int
}

const fakeFolderMime = "application/vnd.google-apps.folder"

func newFakeDrive(t *testing.T) *fakeDrive {
	t.Helper()
	fd := &fakeDrive{
		files: make(map[string]*fakeFile),
		clock: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC),
	}
	fd.server = httptest.NewServer(http.HandlerFunc(fd.serveHTTP))
	t.Cleanup(fd.server.Close)
	return fd
}

// service は指定端末として振る舞う drive.Service を返す。
func (fd *fakeDrive) service(t *testing.T, device string) *drive.Service {
	t.Helper()
	client := &http.Client{Transport: deviceTransport{device: device, base: http.DefaultTransport}}
	srv, err := drive.NewService(context.Background(),
		option.WithEndpoint(fd.server.URL+"/drive/v3/"),
		option.WithHTTPClient(client),
	)
	if err != nil {
		t.Fatalf("failed to create fake drive service: %v", err)
	}
	return srv
}

type deviceTransport struct {
	device string
	base   http.RoundTripper
}

func (d deviceTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	req = req.Clone(req.Context())
	req.Header.Set("X-Fake-Device", d.device)
	return d.base.RoundTrip(req)
}

// ---- 論理時計 ----

func (fd *fakeDrive) nowLocked() string {
	return fd.clock.Format("2006-01-02T15:04:05.000Z")
}

// Now はテストから論理時刻を参照する（ノートの ModifiedTime 生成用）。
func (fd *fakeDrive) Now() string {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	fd.clock = fd.clock.Add(time.Second)
	return fd.clock.Format(time.RFC3339)
}

func (fd *fakeDrive) tickLocked() string {
	fd.clock = fd.clock.Add(time.Second)
	return fd.nowLocked()
}

// ---- モデル操作（ピア端末・テスト初期化から直接使う） ----

func (fd *fakeDrive) CreateFile(name string, parents []string, content []byte, mimeType string) fakeFile {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	return fd.createFileLocked(name, parents, content, mimeType)
}

func (fd *fakeDrive) createFileLocked(name string, parents []string, content []byte, mimeType string) fakeFile {
	ts := fd.tickLocked()
	fd.idSeq++
	if len(parents) == 0 {
		parents = []string{"appDataFolder"}
	}
	f := &fakeFile{
		ID:           fmt.Sprintf("fid-%d", fd.idSeq),
		Name:         name,
		MimeType:     mimeType,
		Parents:      append([]string(nil), parents...),
		Content:      append([]byte(nil), content...),
		Md5:          md5Hex(content),
		Version:      1,
		CreatedTime:  ts,
		ModifiedTime: ts,
	}
	fd.files[f.ID] = f
	fd.changes = append(fd.changes, fakeChange{FileID: f.ID})
	return *f
}

func (fd *fakeDrive) UpdateFile(fileID string, content []byte) (fakeFile, error) {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	return fd.updateFileLocked(fileID, content)
}

func (fd *fakeDrive) updateFileLocked(fileID string, content []byte) (fakeFile, error) {
	f, ok := fd.files[fileID]
	if !ok {
		return fakeFile{}, errFakeNotFound(fileID)
	}
	f.Content = append([]byte(nil), content...)
	f.Md5 = md5Hex(content)
	f.Version++
	f.ModifiedTime = fd.tickLocked()
	fd.changes = append(fd.changes, fakeChange{FileID: fileID})
	return *f, nil
}

func (fd *fakeDrive) DeleteFile(fileID string) error {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	return fd.deleteFileLocked(fileID)
}

func (fd *fakeDrive) deleteFileLocked(fileID string) error {
	f, ok := fd.files[fileID]
	if !ok {
		return errFakeNotFound(fileID)
	}
	delete(fd.files, fileID)
	fd.tickLocked()
	fd.changes = append(fd.changes, fakeChange{FileID: fileID, Removed: true})
	if f.MimeType == fakeFolderMime {
		for _, child := range fd.sortedFilesLocked() {
			for _, p := range child.Parents {
				if p == fileID {
					_ = fd.deleteFileLocked(child.ID)
					break
				}
			}
		}
	}
	return nil
}

func (fd *fakeDrive) Get(fileID string) (fakeFile, bool) {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	f, ok := fd.files[fileID]
	if !ok {
		return fakeFile{}, false
	}
	return *f, true
}

// List は本番コードが使うクエリ形だけを受け付け、未知の句はエラーにする。
func (fd *fakeDrive) List(query string) ([]fakeFile, error) {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	return fd.listLocked(query)
}

func (fd *fakeDrive) listLocked(query string) ([]fakeFile, error) {
	pred, err := parseFakeQuery(query)
	if err != nil {
		return nil, err
	}
	var out []fakeFile
	for _, f := range fd.sortedFilesLocked() {
		if pred(f) {
			out = append(out, *f)
		}
	}
	return out, nil
}

func (fd *fakeDrive) sortedFilesLocked() []*fakeFile {
	out := make([]*fakeFile, 0, len(fd.files))
	for _, f := range fd.files {
		out = append(out, f)
	}
	sort.Slice(out, func(i, j int) bool {
		if out[i].CreatedTime == out[j].CreatedTime {
			return fileSeq(out[i].ID) < fileSeq(out[j].ID)
		}
		return out[i].CreatedTime < out[j].CreatedTime
	})
	return out
}

func fileSeq(id string) int {
	n, _ := strconv.Atoi(strings.TrimPrefix(id, "fid-"))
	return n
}

func (fd *fakeDrive) Requests() []fakeRequest {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	return append([]fakeRequest(nil), fd.requests...)
}

// ---- 障害注入・割り込み ----

// FailWhen は条件に一致するリクエストを times 回だけ指定ステータスで失敗させる。
func (fd *fakeDrive) FailWhen(match func(fakeRequest) bool, status int, times int) {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	fd.failures = append(fd.failures, &fakeFailure{match: match, status: status, remaining: times})
}

// BeforeRequest は条件に一致するリクエストの処理直前に run を実行する（1 回）。
// run の中では fakeDrive のモデル操作（CreateFile 等）を呼んでよい。
func (fd *fakeDrive) BeforeRequest(match func(fakeRequest) bool, run func(fakeRequest)) {
	fd.mu.Lock()
	defer fd.mu.Unlock()
	fd.hooks = append(fd.hooks, &fakeHook{match: match, run: run, remaining: 1})
}

// ---- HTTP ハンドラ ----

var fakeFilePathRe = regexp.MustCompile(`^/(upload/)?drive/v3/files/([^/]+)$`)

func (fd *fakeDrive) serveHTTP(w http.ResponseWriter, r *http.Request) {
	device := r.Header.Get("X-Fake-Device")
	q := r.URL.Query()
	fields := q.Get("fields")

	req, handle, err := fd.route(r)
	if err != nil {
		writeFakeError(w, http.StatusBadRequest, err.Error())
		return
	}
	req.Device = device

	// フックはロック外で実行（フック内でモデル操作をするため）
	fd.mu.Lock()
	if req.FileName == "" && req.FileID != "" {
		if f, ok := fd.files[req.FileID]; ok {
			req.FileName = f.Name
		}
	}
	fd.requests = append(fd.requests, req)
	var toRun []*fakeHook
	for _, h := range fd.hooks {
		if h.remaining > 0 && h.match(req) {
			h.remaining--
			toRun = append(toRun, h)
		}
	}
	fd.mu.Unlock()
	for _, h := range toRun {
		h.run(req)
	}

	fd.mu.Lock()
	for _, f := range fd.failures {
		if f.remaining > 0 && f.match(req) {
			f.remaining--
			fd.mu.Unlock()
			writeFakeError(w, f.status, "Injected failure")
			return
		}
	}
	fd.mu.Unlock()

	handle(w, fields)
}

type fakeHandler func(w http.ResponseWriter, fields string)

func (fd *fakeDrive) route(r *http.Request) (fakeRequest, fakeHandler, error) {
	path := r.URL.Path
	q := r.URL.Query()

	switch {
	case path == "/drive/v3/changes/startPageToken" && r.Method == http.MethodGet:
		return fakeRequest{Op: "changes.getStartPageToken"}, func(w http.ResponseWriter, fields string) {
			fd.mu.Lock()
			token := strconv.Itoa(len(fd.changes) + 1)
			fd.mu.Unlock()
			writeFakeJSON(w, map[string]any{"startPageToken": token})
		}, nil

	case path == "/drive/v3/changes" && r.Method == http.MethodGet:
		return fakeRequest{Op: "changes.list"}, func(w http.ResponseWriter, fields string) {
			fd.mu.Lock()
			defer fd.mu.Unlock()
			token, _ := strconv.Atoi(q.Get("pageToken"))
			if token < 1 {
				token = 1
			}
			pageSize, _ := strconv.Atoi(q.Get("pageSize"))
			if pageSize <= 0 {
				pageSize = 100
			}
			start := token - 1
			if start > len(fd.changes) {
				start = len(fd.changes)
			}
			end := start + pageSize
			if end > len(fd.changes) {
				end = len(fd.changes)
			}
			spec := parseFieldSpec(fields)
			var changes []any
			for _, c := range fd.changes[start:end] {
				item := map[string]any{"fileId": c.FileID, "removed": c.Removed}
				if f, ok := fd.files[c.FileID]; ok && !c.Removed {
					item["file"] = fakeFileResource(f)
				} else {
					item["removed"] = true
				}
				changes = append(changes, applyFieldSpec(item, spec.sub("changes")))
			}
			body := map[string]any{"changes": changes}
			if end < len(fd.changes) {
				body["nextPageToken"] = strconv.Itoa(end + 1)
			} else {
				body["newStartPageToken"] = strconv.Itoa(len(fd.changes) + 1)
			}
			writeFakeJSON(w, body)
		}, nil

	case path == "/drive/v3/files" && r.Method == http.MethodGet:
		query := q.Get("q")
		return fakeRequest{Op: "files.list", Query: query}, func(w http.ResponseWriter, fields string) {
			files, err := fd.List(query)
			if err != nil {
				writeFakeError(w, http.StatusBadRequest, err.Error())
				return
			}
			pageSize, _ := strconv.Atoi(q.Get("pageSize"))
			if pageSize <= 0 {
				pageSize = 100
			}
			offset, _ := strconv.Atoi(q.Get("pageToken"))
			end := offset + pageSize
			if end > len(files) {
				end = len(files)
			}
			spec := parseFieldSpec(fields)
			var out []any
			for i := offset; i < end; i++ {
				f := files[i]
				out = append(out, applyFieldSpec(fakeFileResource(&f), spec.sub("files")))
			}
			body := map[string]any{"files": out}
			if end < len(files) {
				body["nextPageToken"] = strconv.Itoa(end)
			}
			writeFakeJSON(w, body)
		}, nil

	case (path == "/drive/v3/files" || path == "/upload/drive/v3/files") && r.Method == http.MethodPost:
		meta, content, err := readFakeUpload(r)
		if err != nil {
			return fakeRequest{}, nil, err
		}
		return fakeRequest{Op: "files.create", FileName: meta.Name}, func(w http.ResponseWriter, fields string) {
			mimeType := meta.MimeType
			if mimeType == "" {
				mimeType = "application/json"
			}
			f := fd.CreateFile(meta.Name, meta.Parents, content, mimeType)
			writeFakeJSON(w, applyFieldSpec(fakeFileResource(&f), parseFieldSpec(fields)))
		}, nil
	}

	if m := fakeFilePathRe.FindStringSubmatch(path); m != nil {
		fileID := m[2]
		isUpload := m[1] != ""
		switch {
		case r.Method == http.MethodPatch:
			var content []byte
			var err error
			if isUpload {
				_, content, err = readFakeUpload(r)
				if err != nil {
					return fakeRequest{}, nil, err
				}
			}
			return fakeRequest{Op: "files.update", FileID: fileID}, func(w http.ResponseWriter, fields string) {
				f, err := fd.UpdateFile(fileID, content)
				if err != nil {
					writeFakeError(w, http.StatusNotFound, err.Error())
					return
				}
				writeFakeJSON(w, applyFieldSpec(fakeFileResource(&f), parseFieldSpec(fields)))
			}, nil
		case r.Method == http.MethodDelete:
			return fakeRequest{Op: "files.delete", FileID: fileID}, func(w http.ResponseWriter, fields string) {
				if err := fd.DeleteFile(fileID); err != nil {
					writeFakeError(w, http.StatusNotFound, err.Error())
					return
				}
				w.WriteHeader(http.StatusNoContent)
			}, nil
		case r.Method == http.MethodGet && q.Get("alt") == "media":
			return fakeRequest{Op: "files.download", FileID: fileID}, func(w http.ResponseWriter, fields string) {
				f, ok := fd.Get(fileID)
				if !ok {
					writeFakeError(w, http.StatusNotFound, errFakeNotFound(fileID).Error())
					return
				}
				w.Header().Set("Content-Type", f.MimeType)
				_, _ = w.Write(f.Content)
			}, nil
		case r.Method == http.MethodGet:
			return fakeRequest{Op: "files.get", FileID: fileID}, func(w http.ResponseWriter, fields string) {
				f, ok := fd.Get(fileID)
				if !ok {
					writeFakeError(w, http.StatusNotFound, errFakeNotFound(fileID).Error())
					return
				}
				writeFakeJSON(w, applyFieldSpec(fakeFileResource(&f), parseFieldSpec(fields)))
			}, nil
		}
	}
	return fakeRequest{}, nil, fmt.Errorf("fakeDrive: unsupported request %s %s", r.Method, r.URL.String())
}

type fakeUploadMeta struct {
	Name     string   `json:"name"`
	MimeType string   `json:"mimeType"`
	Parents  []string `json:"parents"`
}

func readFakeUpload(r *http.Request) (fakeUploadMeta, []byte, error) {
	var meta fakeUploadMeta
	mediaType, params, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil {
		return meta, nil, fmt.Errorf("bad content type: %w", err)
	}
	if !strings.HasPrefix(mediaType, "multipart/") {
		body, err := io.ReadAll(r.Body)
		if err != nil {
			return meta, nil, err
		}
		if mediaType == "application/json" && r.URL.Path == "/drive/v3/files" {
			// メタデータのみの作成（フォルダ）
			if err := json.Unmarshal(body, &meta); err != nil {
				return meta, nil, err
			}
			return meta, nil, nil
		}
		return meta, body, nil
	}
	mr := multipart.NewReader(r.Body, params["boundary"])
	part, err := mr.NextPart()
	if err != nil {
		return meta, nil, fmt.Errorf("missing metadata part: %w", err)
	}
	metaBytes, _ := io.ReadAll(part)
	if len(metaBytes) > 0 {
		if err := json.Unmarshal(metaBytes, &meta); err != nil {
			return meta, nil, fmt.Errorf("bad metadata: %w", err)
		}
	}
	part, err = mr.NextPart()
	if err != nil {
		return meta, nil, fmt.Errorf("missing media part: %w", err)
	}
	content, err := io.ReadAll(part)
	return meta, content, err
}

func fakeFileResource(f *fakeFile) map[string]any {
	res := map[string]any{
		"kind":         "drive#file",
		"id":           f.ID,
		"name":         f.Name,
		"mimeType":     f.MimeType,
		"parents":      f.Parents,
		"version":      strconv.FormatInt(f.Version, 10),
		"createdTime":  f.CreatedTime,
		"modifiedTime": f.ModifiedTime,
		"trashed":      false,
		"size":         strconv.Itoa(len(f.Content)),
	}
	if f.MimeType != fakeFolderMime {
		res["md5Checksum"] = f.Md5
	}
	return res
}

// ---- fields パラメータ ----

type fieldSpec map[string]fieldSpec // nil 値 = 葉

func (s fieldSpec) sub(key string) fieldSpec {
	if s == nil {
		return nil
	}
	return s[key]
}

func parseFieldSpec(fields string) fieldSpec {
	if strings.TrimSpace(fields) == "" {
		return nil
	}
	i := 0
	var parse func() fieldSpec
	parse = func() fieldSpec {
		spec := fieldSpec{}
		name := ""
		flush := func() {
			n := strings.TrimSpace(name)
			if n != "" {
				spec[n] = nil
			}
			name = ""
		}
		for i < len(fields) {
			ch := fields[i]
			switch ch {
			case '(':
				i++
				n := strings.TrimSpace(name)
				name = ""
				spec[n] = parse()
			case ')':
				i++
				flush()
				return spec
			case ',':
				i++
				flush()
			default:
				name += string(ch)
				i++
			}
		}
		flush()
		return spec
	}
	return parse()
}

// applyFieldSpec は要求されたフィールドだけを残す。spec が nil なら Drive 既定の最小セット。
func applyFieldSpec(obj map[string]any, spec fieldSpec) map[string]any {
	if spec == nil {
		out := map[string]any{}
		for _, k := range []string{"kind", "id", "name", "mimeType", "fileId", "removed", "file"} {
			if v, ok := obj[k]; ok {
				out[k] = v
			}
		}
		return out
	}
	out := map[string]any{}
	for k, sub := range spec {
		v, ok := obj[k]
		if !ok {
			continue
		}
		if nested, isMap := v.(map[string]any); isMap && sub != nil {
			out[k] = applyFieldSpec(nested, sub)
			continue
		}
		out[k] = v
	}
	return out
}

// ---- クエリ ----

var (
	fakeNameClauseRe    = regexp.MustCompile(`^name\s*=\s*'((?:[^'\\]|\\.)*)'$`)
	fakeParentsClauseRe = regexp.MustCompile(`^'((?:[^'\\]|\\.)*)'\s+in\s+parents$`)
	fakeMimeClauseRe    = regexp.MustCompile(`^mimeType\s*(!?=)\s*'((?:[^'\\]|\\.)*)'$`)
	fakeTrashedClauseRe = regexp.MustCompile(`^trashed\s*=\s*(true|false)$`)
	fakeUnescapeRe      = regexp.MustCompile(`\\(.)`)
)

func parseFakeQuery(query string) (func(*fakeFile) bool, error) {
	var preds []func(*fakeFile) bool
	for _, raw := range splitFakeAnd(strings.TrimSpace(query)) {
		c := strings.TrimSpace(raw)
		if c == "" {
			continue
		}
		if m := fakeNameClauseRe.FindStringSubmatch(c); m != nil {
			v := fakeUnescapeRe.ReplaceAllString(m[1], "$1")
			preds = append(preds, func(f *fakeFile) bool { return f.Name == v })
			continue
		}
		if m := fakeParentsClauseRe.FindStringSubmatch(c); m != nil {
			v := fakeUnescapeRe.ReplaceAllString(m[1], "$1")
			preds = append(preds, func(f *fakeFile) bool {
				for _, p := range f.Parents {
					if p == v {
						return true
					}
				}
				return false
			})
			continue
		}
		if m := fakeMimeClauseRe.FindStringSubmatch(c); m != nil {
			neg := m[1] == "!="
			v := fakeUnescapeRe.ReplaceAllString(m[2], "$1")
			preds = append(preds, func(f *fakeFile) bool { return (f.MimeType == v) != neg })
			continue
		}
		if m := fakeTrashedClauseRe.FindStringSubmatch(c); m != nil {
			want := m[1] == "true"
			preds = append(preds, func(f *fakeFile) bool { return want == false })
			continue
		}
		return nil, fmt.Errorf("fakeDrive: unsupported query clause: %s", c)
	}
	return func(f *fakeFile) bool {
		for _, p := range preds {
			if !p(f) {
				return false
			}
		}
		return true
	}, nil
}

func splitFakeAnd(query string) []string {
	var parts []string
	var current strings.Builder
	inQuote := false
	for i := 0; i < len(query); i++ {
		ch := query[i]
		if ch == '\\' && inQuote && i+1 < len(query) {
			current.WriteByte(ch)
			current.WriteByte(query[i+1])
			i++
			continue
		}
		if ch == '\'' {
			inQuote = !inQuote
		}
		if !inQuote && i+5 <= len(query) && strings.EqualFold(query[i:i+5], " and ") {
			parts = append(parts, current.String())
			current.Reset()
			i += 4
			continue
		}
		current.WriteByte(ch)
	}
	parts = append(parts, current.String())
	return parts
}

// ---- 共通 ----

func md5Hex(b []byte) string {
	sum := md5.Sum(b)
	return hex.EncodeToString(sum[:])
}

func errFakeNotFound(fileID string) error {
	return fmt.Errorf("File not found: %s.", fileID)
}

func writeFakeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(v)
}

func writeFakeError(w http.ResponseWriter, status int, message string) {
	reason := "backendError"
	switch status {
	case http.StatusNotFound:
		reason = "notFound"
	case http.StatusUnauthorized:
		reason = "authError"
	case http.StatusForbidden:
		reason = "forbidden"
	case http.StatusBadRequest:
		reason = "badRequest"
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(map[string]any{
		"error": map[string]any{
			"code":    status,
			"message": message,
			"errors":  []any{map[string]any{"domain": "global", "reason": reason, "message": message}},
		},
	})
}
