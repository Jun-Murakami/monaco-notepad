package backend

import (
	"sync"
	"testing"

	"github.com/stretchr/testify/assert"
)

// drive:reauth-required の重複抑止フラグ。
// 「1 オフラインセッションあたり 1 度だけ」の挙動を保証するための回帰テスト群。

func TestDriveSync_MarkReauthNotified_FirstCallReturnsTrue(t *testing.T) {
	ds := &DriveSync{}
	assert.True(t, ds.MarkReauthNotified(), "初回呼び出しは true (= 通知してよい)")
}

func TestDriveSync_MarkReauthNotified_SecondCallReturnsFalse(t *testing.T) {
	ds := &DriveSync{}
	ds.MarkReauthNotified()
	assert.False(t, ds.MarkReauthNotified(), "2 回目は false (重複通知抑止)")
}

func TestDriveSync_SetConnected_True_ResetsReauthFlag(t *testing.T) {
	ds := &DriveSync{}
	ds.MarkReauthNotified()                      // フラグを立てる
	assert.False(t, ds.MarkReauthNotified())     // 重複抑止で false
	ds.SetConnected(true)                        // 接続復帰でリセット
	assert.True(t, ds.MarkReauthNotified(), "接続復帰後は再通知できるべき")
}

func TestDriveSync_SetConnected_False_DoesNotResetReauthFlag(t *testing.T) {
	ds := &DriveSync{}
	ds.MarkReauthNotified()
	ds.SetConnected(false) // オフラインへ遷移してもフラグは保持
	assert.False(t, ds.MarkReauthNotified(), "オフライン遷移ではリセットされない")
}

func TestDriveSync_MarkReauthNotified_ConcurrentSafe(t *testing.T) {
	// 複数 goroutine が同時に MarkReauthNotified を呼んでも、true を返すのは
	// ちょうど 1 回だけ。残りは false。
	ds := &DriveSync{}
	const goroutines = 20
	results := make([]bool, goroutines)
	var wg sync.WaitGroup
	wg.Add(goroutines)
	for i := 0; i < goroutines; i++ {
		go func(idx int) {
			defer wg.Done()
			results[idx] = ds.MarkReauthNotified()
		}(i)
	}
	wg.Wait()

	trueCount := 0
	for _, r := range results {
		if r {
			trueCount++
		}
	}
	assert.Equal(t, 1, trueCount, "並行呼び出しでも通知権を取れるのはちょうど 1 つの goroutine だけ")
}

func TestIsModifiedTimeAfter_BasicComparison(t *testing.T) {
	older := "2025-01-01T00:00:00Z"
	newer := "2025-06-15T12:30:00Z"

	assert.True(t, isModifiedTimeAfter(newer, older))
	assert.False(t, isModifiedTimeAfter(older, newer))
}

func TestIsModifiedTimeAfter_SameTime(t *testing.T) {
	same := "2025-03-10T08:00:00Z"
	assert.False(t, isModifiedTimeAfter(same, same))
}

func TestIsModifiedTimeAfter_DifferentTimezones(t *testing.T) {
	utc := "2025-06-15T12:00:00Z"
	jst := "2025-06-15T21:00:00+09:00"

	assert.False(t, isModifiedTimeAfter(utc, jst), "same instant in different TZ should not be 'after'")
	assert.False(t, isModifiedTimeAfter(jst, utc), "same instant in different TZ should not be 'after'")
}

func TestIsModifiedTimeAfter_TimezoneOrderDifference(t *testing.T) {
	earlier := "2025-06-15T10:00:00+09:00" // = 01:00 UTC
	later := "2025-06-15T10:00:00Z"        // = 10:00 UTC

	assert.True(t, isModifiedTimeAfter(later, earlier),
		"string comparison would get this wrong: both start with 2025-06-15T10:00:00 but UTC offset matters")
	assert.False(t, isModifiedTimeAfter(earlier, later))
}

func TestIsModifiedTimeAfter_SubSecondPrecision(t *testing.T) {
	a := "2025-06-15T12:00:00.000Z"
	b := "2025-06-15T12:00:00.001Z"

	assert.True(t, isModifiedTimeAfter(b, a))
	assert.False(t, isModifiedTimeAfter(a, b))
}

func TestIsModifiedTimeAfter_InvalidStrings_FallbackToStringComparison(t *testing.T) {
	assert.True(t, isModifiedTimeAfter("zzz", "aaa"), "invalid strings should fall back to string '>'")
	assert.False(t, isModifiedTimeAfter("aaa", "zzz"))
}

func TestIsModifiedTimeAfter_OneInvalidString(t *testing.T) {
	valid := "2025-06-15T12:00:00Z"
	invalid := "not-a-time"

	assert.False(t, isModifiedTimeAfter(valid, invalid),
		"fallback to string comparison: '2' < 'n' so '2025...' < 'not-a-time'")
	assert.True(t, isModifiedTimeAfter(invalid, valid),
		"fallback to string comparison: 'n' > '2'")
}

func TestIsModifiedTimeAfter_EmptyStrings(t *testing.T) {
	assert.False(t, isModifiedTimeAfter("", ""))
	assert.False(t, isModifiedTimeAfter("", "2025-01-01T00:00:00Z"))
	assert.True(t, isModifiedTimeAfter("2025-01-01T00:00:00Z", ""))
}
