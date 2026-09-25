package backend

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// notificationRecorder は AppLogger の呼び出しを記録するテスト用ロガー。
type notificationRecorder struct {
	AppLogger

	mu                   sync.Mutex
	driveStatusCalls     []string
	infoCalls            []string
	errorCalls           []string
	errorWithNotifyCalls []string
	consoleCalls         []string
	syncedAndReloadCalls int
}

func newNotificationRecorder(ctx context.Context, tempDir string) *notificationRecorder {
	base := NewAppLogger(ctx, true, tempDir)
	return &notificationRecorder{AppLogger: base}
}

func (r *notificationRecorder) NotifyDriveStatus(ctx context.Context, status string) {
	r.mu.Lock()
	r.driveStatusCalls = append(r.driveStatusCalls, status)
	r.mu.Unlock()
	r.AppLogger.NotifyDriveStatus(ctx, status)
}

func (r *notificationRecorder) NotifyFrontendSyncedAndReload(ctx context.Context) {
	r.mu.Lock()
	r.syncedAndReloadCalls++
	r.mu.Unlock()
	r.AppLogger.NotifyFrontendSyncedAndReload(ctx)
}

func (r *notificationRecorder) Info(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	r.mu.Lock()
	r.infoCalls = append(r.infoCalls, msg)
	r.mu.Unlock()
	r.AppLogger.Info(format, args...)
}

func (r *notificationRecorder) InfoCode(code string, args map[string]interface{}) {
	msg := code
	switch code {
	case MsgDriveUploading:
		msg = fmt.Sprintf("Drive: uploading \"%v\"", args["noteTitle"])
	case MsgDriveUploaded:
		msg = fmt.Sprintf("Drive: uploaded \"%v\"", args["noteId"])
	case MsgDriveUpdating:
		msg = fmt.Sprintf("Drive: updating \"%v\"", args["noteId"])
	case MsgDriveUpdated:
		msg = fmt.Sprintf("Drive: updated \"%v\"", args["noteId"])
	case MsgDriveDeletingNote:
		msg = fmt.Sprintf("Drive: deleting note %v", args["noteId"])
	case MsgDriveDeletedNote:
		msg = "Drive: deleted note from cloud"
	case MsgSystemIntegrityAutoRepaired:
		msg = fmt.Sprintf("Integrity check: auto-repaired local data (%v change(s))", args["count"])
	}
	r.mu.Lock()
	r.infoCalls = append(r.infoCalls, msg)
	r.mu.Unlock()
	r.AppLogger.InfoCode(code, args)
}

func (r *notificationRecorder) Error(err error, format string, args ...interface{}) error {
	if err != nil {
		msg := fmt.Sprintf(format, args...)
		r.mu.Lock()
		r.errorCalls = append(r.errorCalls, fmt.Sprintf("%s: %v", msg, err))
		r.mu.Unlock()
	}
	return r.AppLogger.Error(err, format, args...)
}

func (r *notificationRecorder) ErrorWithNotify(err error, format string, args ...interface{}) error {
	if err != nil {
		msg := fmt.Sprintf(format, args...)
		r.mu.Lock()
		r.errorWithNotifyCalls = append(r.errorWithNotifyCalls, fmt.Sprintf("%s: %v", msg, err))
		r.mu.Unlock()
	}
	return r.AppLogger.ErrorWithNotify(err, format, args...)
}

func (r *notificationRecorder) Console(format string, args ...interface{}) {
	msg := fmt.Sprintf(format, args...)
	r.mu.Lock()
	r.consoleCalls = append(r.consoleCalls, msg)
	r.mu.Unlock()
	r.AppLogger.Console(format, args...)
}

func (r *notificationRecorder) AssertDriveStatusSequence(t *testing.T, expected []string) {
	t.Helper()
	r.mu.Lock()
	actual := append([]string(nil), r.driveStatusCalls...)
	r.mu.Unlock()
	assert.Equal(t, expected, actual)
}

func (r *notificationRecorder) AssertInfoContains(t *testing.T, substr string) {
	t.Helper()
	r.mu.Lock()
	actual := append([]string(nil), r.infoCalls...)
	r.mu.Unlock()
	for _, msg := range actual {
		if strings.Contains(msg, substr) {
			return
		}
	}
	assert.Failf(t, "expected info log not found", "substring %q not found in info logs: %v", substr, actual)
}

func (r *notificationRecorder) AssertNoSyncedAfterError(t *testing.T) {
	t.Helper()
	r.mu.Lock()
	statuses := append([]string(nil), r.driveStatusCalls...)
	r.mu.Unlock()

	lastSyncing := -1
	for i, status := range statuses {
		if status == "syncing" {
			lastSyncing = i
		}
	}
	require.NotEqual(t, -1, lastSyncing, "expected at least one syncing status")

	for i := lastSyncing + 1; i < len(statuses); i++ {
		assert.NotEqual(t, "synced", statuses[i], "synced should not appear after final syncing on error path")
	}
}

func (r *notificationRecorder) statusCalls() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.driveStatusCalls...)
}

func (r *notificationRecorder) syncedReloadCount() int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.syncedAndReloadCalls
}
