package backend

import (
	"strings"
	"testing"
)

// TestRedactLogMessage はログ秘匿処理がトークン/OAuthコード/パスを伏字にし、
// 無関係な値（HTTPステータスコード等）を巻き込まないことを検証する。
func TestRedactLogMessage(t *testing.T) {
	cases := []struct {
		name          string
		in            string
		mustNotAppear []string // 出力に残ってはいけない秘匿対象
		mustContain   []string // 出力に残っていてほしい無害な文字列
	}{
		{
			name:          "access_token は伏字",
			in:            "got access_token=ya29.SECRETVALUE12345 ok",
			mustNotAppear: []string{"ya29.SECRETVALUE12345"},
		},
		{
			name:          "refresh_token は伏字",
			in:            `{"refresh_token":"1//09SECRETrefreshTOKENvalue"}`,
			mustNotAppear: []string{"1//09SECRETrefreshTOKENvalue"},
		},
		{
			name:          "client_secret は伏字",
			in:            "client_secret=GOCSPX-abcdefSECRET12345",
			mustNotAppear: []string{"GOCSPX-abcdefSECRET12345"},
		},
		{
			name:          "OAuth 認可コード(クエリ形式)は伏字",
			in:            "redirect http://127.0.0.1/oauth2callback?code=4/0ASECRETauthCODEvalue&state=xyz",
			mustNotAppear: []string{"4/0ASECRETauthCODEvalue"},
		},
		{
			name:        "HTTP ステータスコードは伏字にしない",
			in:          "request failed with status code: 404",
			mustContain: []string{"404"},
		},
		{
			name:          "Windows パスは伏字",
			in:            `loaded C:\Users\alice\AppData\monaco-notepad\token.json`,
			mustNotAppear: []string{"alice", "token.json"},
		},
		{
			name:          "macOS /private パスは伏字",
			in:            "tmpfile /private/var/folders/xy/secretpath/file",
			mustNotAppear: []string{"secretpath"},
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			out := redactLogMessage(c.in)
			for _, s := range c.mustNotAppear {
				if strings.Contains(out, s) {
					t.Errorf("秘匿対象が残っている: %q\n入力: %q\n出力: %q", s, c.in, out)
				}
			}
			for _, s := range c.mustContain {
				if !strings.Contains(out, s) {
					t.Errorf("残るべき値が消えた: %q\n入力: %q\n出力: %q", s, c.in, out)
				}
			}
		})
	}
}
