package backend

import (
	"testing"

	"github.com/stretchr/testify/assert"
)

// ノート本体の系譜（syncParentVersion / syncSkipped）の読み取り。mobile の codec.test.ts と同じ扱い。
func TestParseNoteLineage(t *testing.T) {
	assert.Equal(t,
		noteLineage{ParentVersion: 7, Skipped: []versionRange{{3, 4}, {6, 6}}},
		parseNoteLineage([]byte(`{"id":"a","syncParentVersion":7,"syncSkipped":[[6,6],[3,4]]}`)))

	for _, bad := range []string{`0`, `-1`, `1.5`, `"3"`, `null`} {
		got := parseNoteLineage([]byte(`{"id":"a","syncParentVersion":` + bad + `}`))
		assert.Equal(t, noteLineage{}, got, bad)
	}
	assert.Equal(t, noteLineage{}, parseNoteLineage([]byte(`{"id":"a"}`)), "旧クライアントの書き込み")

	broken := parseNoteLineage([]byte(`{"id":"a","syncParentVersion":5,"syncSkipped":[[2,1],"x",[1.5,2],[3,3]]}`))
	assert.Equal(t, noteLineage{ParentVersion: 5, Skipped: []versionRange{{3, 3}}}, broken)
}
