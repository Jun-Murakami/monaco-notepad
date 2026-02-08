package backend

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

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
