# 同期エンジン v3 仕様（デスクトップ / モバイル共通）

> 作成: 2026-09-25 / ブランチ `refactor/sync-engine`
> 対象: `backend/`（Go）と `mobile/src/services/sync/`（TS）の両実装。
> **本書が唯一の仕様**。両実装は `sync-spec/vectors/` の共有テストベクターで一致を機械的に検証する。

## 1. なぜ作り直すか

### 1.1 報告された症状と根本原因

| 症状 | 主な根本原因 |
|---|---|
| ① 相手端末の変更が反映されない | noteList を読み直さずに丸ごと上書き（lost update）。自分の書き込み後に Changes トークン / `LastSyncedDriveTs` を「現在」に進めて相手の書き込みを同期済み扱い。ダウンロード失敗時もクラウド hash を採用して二度と再取得しない。noteList の contentHash を「Drive 上の本文の真実」として信頼し、上書きで壊れると回復しない。 |
| ② 最新ノートが下に来る | 競合時の順序マージが「ローカル順 + クラウドのみの項目を末尾」。ノート本体ファイルの folderId（デスクトップのファイルには無い）で所属を上書きしフォルダから外れる → 整合性修復で末尾に追加。 |
| ③ 他端末で「不明ノート」に入る | 「noteList に無いファイル = 孤立」判定が、アップロード途中（本体→noteList の間）や lost update で消えたノートを誤検知。同期がローカル noteList を古いスナップショットで丸ごと置換し、同期中に作られたノートを落とす → 整合性チェックが孤立扱い。不明ノートへの移動が構造マージでクラウドへ伝播。 |

### 1.2 設計上の根本原因

1. 1 つの noteList ファイルを競合検出なしで read-modify-write している。
2. 「無いこと」から削除・孤立を推論している。
3. base（前回同期時点）を持たない 2-way マージなので「誰が変えたか」が分からず、local 優先 / cloud 優先の場当たりルールになる。
4. デスクトップとモバイルが別々のルールで書かれ、一致を担保する仕組みが無い。

2026-02 の移行（`docs/sync-architecture-migration-plan.md`）は「フィールド単位 2-way マージの状態爆発」を避けるため丸ごと上書きへ寄せたが、それが 1. の lost update を生んだ。v3 は 2-way マージへ戻るのではなく、**base 付き 3-way マージを純粋関数として定義し、共有ベクターと複数端末シミュレーションで予測可能性を担保する**。

## 2. 原則

| # | 原則 |
|---|---|
| P1 | **本文の変更検知は Drive のファイル一覧（md5Checksum）で行う。** noteList の contentHash は表示用メタであり、同期判定には使わない。 |
| P2 | **削除は明示的な操作だけ。** リモート削除 = Drive 上の本体ファイルが消えたこと。ローカル削除 = ユーザー操作で記録した `deletedNoteIDs`。noteList に「無い」ことを削除とみなさない。 |
| P3 | **構造（フォルダ・順序・所属）は base 付き 3-way マージ。** 自分が変えたものだけを相手の状態に重ねる。 |
| P4 | **編集は削除に勝つ。** 片方で編集、他方で削除された場合はノートを残す。 |
| P5 | **失敗したものは同期済みにしない。** 成功したノートだけ base を進める。失敗は次サイクルで必ず再試行される。 |
| P6 | **同期中のユーザー操作を落とさない。** コミットはローカルロック内で「その時点のローカル」に対して再マージする。 |
| P7 | **folderId は noteList だけが正。** ノート本体ファイルの folderId は読まない（書き込み側は含めても含めなくてもよい）。 |
| P8 | **不明ノートフォルダへの自動移動はしない。** 配置情報の無いノートは新規ノートと同じくトップレベル先頭に置く。 |
| P9 | **自分の書き込み後に変更検知の基準を進めない。** Changes トークンは消費したぶんだけ進める。 |

## 3. Drive 上のデータ（v2 と互換・変更なし）

```
appDataFolder/monaco-notepad/          ← 同名が複数あれば createdTime 最古（同値は id 昇順）を使う
  ├── noteList_v2.json                 ← NoteList（構造 + 表示用メタ）
  └── notes/<noteId>.json              ← Note 本体（id,title,content,contentHeader,language,modifiedTime,archived[,folderId]）
```

- `version` は情報用で意味を持たない（デスクトップ "2.0" / モバイル "v2"）。
- 旧クライアントが同じ Drive を使っても形式は壊れない（旧クライアント自身の不具合は残る）。

## 4. 端末ローカルの同期状態

| 保存先 | 内容 |
|---|---|
| `sync_state.json`（既存・スキーマ互換） | `dirty`, `dirtyNoteIDs`, `deletedNoteIDs`, `deletedFolderIDs`: 未送信のローカル変更の記録。v2 の `lastSyncedNoteHash` は base が無いときだけ base の本文 hash として読み、最初の同期サイクルの終了時に（失敗しても）空にする。以後 base が無いときは和集合で同期する。 |
| `sync_base.json`（新規） | `{ version, rootFolderId, noteListFileId, noteListMd5, noteList, notes: { <id>: { hash, md5?, fileId? } } }`: 最後に同期が確定した時点のクラウド noteList と、ノートごとの本文 hash / Drive 本体 md5 / ファイル ID。 |

- base は Drive（アカウント）に紐づく。`rootFolderId` / `noteListFileId` が現在と違えば base は無効（null）。
- Drive データ全削除 / クラウド noteList 消失時は base を破棄する（→ 次回は和集合で安全に再同期、ローカル削除は起きない）。
- 連携解除（サインアウト）では base も未送信の変更も**破棄しない**。同じアカウントへの再接続は「オフラインからの復帰」と
  同じ扱いになる（base を捨てると、相手の削除を取り込めずに復活させる / 離れていた間の移動・並び替えを失う /
  衝突していないのにバックアップを作る）。別のアカウントに接続した場合は `rootFolderId` が違うので base は使われない。
- `deletedNoteIDs` は意図の記録であり、処理が確定した ID だけ個別に消す。他の dirty 系はヒント（同期を急がせる合図）で、正しさは base との差分で決まる。

## 5. 1 サイクルの流れ（両実装共通）

```
syncOnce()  ※ 端末内の sync ロックで直列化
 1. リモート読み取り
    a. root / notes / noteList のファイル ID と noteList の md5 を取得
    b. notes フォルダを全ページ列挙 → noteId -> {fileId, md5, modifiedTime}
       （同名重複は modifiedTime 最新を採用、残りは後で削除）
    c. noteList の md5 が base と同じなら base.noteList を remote として使う（ダウンロード省略）
 2. ローカルのスナップショット（ローカルロック内で複製）
 3. ノート判定フェーズ1（decideNote・§6）→ ダウンロードが必要なノートを取得
 4. ノート判定フェーズ2 → アクション確定
 5. リモート変更の実行: 本体アップロード / 本体削除（成功したものだけ記録）
 6. ローカルコミット（ローカルロック内・ネットワーク I/O なし）
    - applyRemote / deleteLocal は「スナップショット以降にユーザーが触っていない」ノートだけ適用
    - mergeNoteList（§7）を「現在の」ローカルに対して実行し、ローカル noteList を保存
 7. noteList アップロード
    - クラウドに載せるのは本体が Drive に確定しているノートだけ（§7.5）
    - アップロード直前に noteList の md5 を再確認し、1. から変わっていたら 1. からやり直す（最大 3 回）
    - 書き込み応答の `version` が再確認時の +1 でなければ、確認〜書き込みの間に他端末が書いた
      （= 上書きした）ので、その場でもう一度サイクルを回す。相手のノート本体は Drive に残っているので
      存在は必ず取り戻せる（失われうるのは相手の並び替えなど構造の変更だけ）
    - remote と同一内容ならアップロードしない
 8. base を更新（noteList = 7 で確定したクラウドの内容、ノートごとの hash / md5）
```

## 6. ノート単位の判定 `decideNote`

入力（ノート ID ごと）:

- `local?`: `{hash, modifiedTime}` ローカルに存在する場合（本体ファイルが読めること）
- `localDeleted`: `deletedNoteIDs` に含まれる
- `base?`: `{hash, md5?, fileId?}` 前回同期時点（md5 / fileId は移行直後などで欠けうる）
- `remote?`: `{md5, fileId?}` Drive に本体ファイルがある場合
- `downloaded?`: `{hash, modifiedTime}` フェーズ2でのみ与える（ダウンロード結果）

出力: `none` / `download`（フェーズ1のみ）/ `upload{backupRemote}` / `applyRemote{backupLocal}` / `deleteLocal{backupLocal}` / `deleteRemote` / `forget`

```
if !local:
  if localDeleted:
    if !remote:                          → forget
    if !base:                            → deleteRemote
    if base.md5 && remote.md5 == base.md5 → deleteRemote
    if !downloaded:                      → download
    downloaded.hash == base.hash ? deleteRemote : applyRemote{false}   // P4: 相手の編集が勝つ
  if remote: downloaded ? applyRemote{false} : download              // 新規 or ローカルから消えた
  → forget                                                           // 両方に無い
if !remote:
  if !base || local.hash != base.hash:   → upload                    // 新規 or 編集が削除に勝つ
  → deleteLocal{backupLocal:true}
if base && base.md5 && remote.md5 == base.md5:
  local.hash == base.hash ? none : upload
if !downloaded:                          → download
if downloaded.hash == local.hash:        → none                      // 収束済み
if !base || local.hash != base.hash:     // ローカルも変更あり
  if base && downloaded.hash == base.hash → upload                   // md5 だけ違う（再シリアライズ）
  isAfter(local.modifiedTime, downloaded.modifiedTime) ? upload{backupRemote:true} : applyRemote{backupLocal:true}
// 手元は未変更
if base.fileId && remote.fileId && base.fileId != remote.fileId:
  → applyRemote{backupLocal:true}      // 一度削除され、編集が勝って作り直された（削除より後の出来事）
// 同じファイルでリモートの方が古い = 別端末が古い判断で上書きした（ノート本体の lost update）
isAfter(local.modifiedTime, downloaded.modifiedTime) ? upload{backupRemote:true} : applyRemote{false}
```

- 結果として「常に modifiedTime の新しい版が勝つ」。Drive は条件付き更新ができないため、
  判断から書き込みまでの間に別端末が新しい版を書いても上書きしうるが、上書きされた側が次の同期で
  より新しい手元の版を送り直すので、新しい版が失われない（ランダム・シミュレーションで検出した経路）。
  上書きしてきた版もその端末のユーザーの編集なので、送り直す側がバックアップに残す（`backupRemote`）。
- ただしファイルが作り直されている（`fileId` が base と違う）場合は、削除 → 「編集は削除に勝つ」による復元なので
  時刻にかかわらず取り込む。古い版の送り直しを適用すると、削除された版が復活し、復元した編集が消える
  （オフライン・シミュレーションで検出した経路）。

- 両側で編集された（真の競合）ときは、負けた版を必ず競合バックアップに残す:
  ローカルが負け → `backupLocal`（`cloud_wins`）、リモートが負け → `backupRemote`（`local_wins`、上書き前にダウンロード済みの版）。
  リモート削除でローカルを消すとき → `deleteLocal{backupLocal}`（`cloud_delete`）。
- `isAfter(a, b)`: RFC3339 として解析できれば時刻比較、できなければ文字列比較。**同時刻はリモート勝ち**。
- `applyRemote` が `localDeleted` のノートに対して出た場合、そのノートの削除意図は取り消す。

## 7. 構造マージ `mergeNoteList(base, local, remote, notes)`

`notes` はマージ後に存在するノートの最終メタ（id, title, contentHeader, language, modifiedTime, archived, contentHash）。folderId と並び順はここで決める。

### 7.1 base が無い場合
「両側にある項目はローカルでは変更されていない」とみなす（= リモートが優先、ローカルにしか無いものはローカルの追加）。
順序では `base := local ∩ remote（local の順）`、所属・フォルダ属性では `base := local の値`、集合では `base := local ∩ remote`。

### 7.2 順序の 3-way マージ `mergeSequence(base, local, remote)`（キーの列）
1. `result := remote`（重複除去）
2. base にあり local に無いキーを result から除く（ローカルで除去・移動）
3. `lcs := LCS(base, local)`。local にあって lcs に無いキーを「ローカルで追加・移動したもの」とし、local の順に処理:
   result から取り除き、local 上で手前にある最初の「result に存在するキー」の直後に挿入（無ければ先頭）
4. LCS の復元は決定的に行う: 接尾辞 DP `L[i][j]` を作り、`(0,0)` から
   `base[i]==local[j]` なら採用、そうでなければ `L[i+1][j] >= L[i][j+1]` なら `i++`、それ以外は `j++`。

### 7.3 フォルダ
- 候補 ID の並び: remote の順 → local のみ → base のみ。
- 存在判定: `L&&R` / `L&&!R&&(!B || localChanged)` / `!L&&R&&!B` のとき存在。さらに、最終ノートのいずれかが所属している場合は復活させる（P4）。
- 属性（name, archived）は項目ごとに 3-way: `local != base` なら local、そうでなければ remote（無ければ local）。

### 7.4 ノートの所属 folderId と各系列
- folderId: `local に値があり (base に無い || local != base)` なら local、それ以外は remote → local → base の順で最初にある値。
  存在しないフォルダ → `""`。ノートとフォルダのアーカイブ状態が食い違っていたら `""`（アーカイブ済みノートが
  アクティブなフォルダに / アクティブなノートがアーカイブ済みフォルダに属する場合。後者は表示されなくなる）。
- `notes` 配列（フォルダ内の表示順）、`topLevelOrder`、`archivedTopLevelOrder` をそれぞれ `mergeSequence` し、有効な項目だけ残す:
  - topLevelOrder: `folderId=="" && !archived` のノート、`!archived` のフォルダ
  - archivedTopLevelOrder: `archived && folderId==""` のノート、`archived` のフォルダ
- どの系列にも位置が無い有効項目は**先頭**に入れる（フォルダを id 昇順、続いてノートを modifiedTime 降順・id 昇順）。
- `collapsedFolderIDs`: 集合の 3-way（`remote ∪ (local−base)) − (base−local)`、remote の順 → 追加分）。存在するフォルダだけ。

### 7.5 ローカル用とクラウド用
同じ `mergeNoteList` を 2 つのノート集合で呼ぶ:
- ローカル用: この端末に存在するノート全部。
- クラウド用: 本体が Drive に確定しているノートだけ（アップロード失敗・同期中に作られたノートは除く。ダウンロードに失敗したリモートノートは remote のメタをそのまま通す）。

## 8. 変更検知（ポーリング）

- Changes API のトークンは消費したぶんだけ進める。自分の書き込みも「変更」として届くが、次サイクルは md5 比較だけで終わる。
- 取りこぼし対策として、変更が無くても一定間隔（5 分）でフル判定を行う。
- ローカルが dirty なら即座に同期する（モバイルは保存後に数秒 debounce）。

## 9. テスト戦略

| 層 | 目的 | 実体 |
|---|---|---|
| L0 共有ベクター | 純粋関数（§6, §7, hash）の Go / TS 完全一致 | `sync-spec/vectors/*.json` を両テストが読み込む |
| L1 忠実な FakeDrive | 本番の Drive クライアントを通したテスト | Go: `backend/fakedrive_test.go`（httptest）/ TS: `mobile/src/test/fakeDrive.ts`（fetch） |
| L2 端末間シナリオ | 報告された症状の再現（RED → GREEN） | Go: `sync_scenarios_test.go` / TS: `crossDevice.scenarios.test.ts` |
| L3 ランダム・シミュレーション | 未知のレースの検出。静止後に全端末の収束・データ喪失なし・不明ノート無しを検証 | シード付き。失敗時はシードで再現 |

原則: テストは「全端末が同じ状態に収束し、ユーザーのデータが失われない」ことを検証する。呼び出し回数などの実装詳細は検証しない。
