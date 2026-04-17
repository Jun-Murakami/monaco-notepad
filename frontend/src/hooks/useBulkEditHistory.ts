import { useCallback, useRef, useState } from 'react';

// ノート横断の一括操作用 Undo/Redo 履歴。
// Monaco が持つモデルごとの undo stack とは独立に、アプリレベルで管理する。
// スレッドの議論に沿って 2 スタック + 上限 で実装（参照: frogic / NickCanCode / abrahamguo）。

// 1 ノートに対する編集群。original を保持することで逆操作を生成できる。
export interface BulkEdit {
  noteId: string;
  edits: Array<{
    start: number;
    end: number;
    original: string; // 逆編集で差し戻す文字列
    replacement: string; // forward で差し込む文字列
  }>;
}

export interface BulkCommand {
  id: string;
  labelKey: string;
  labelArgs?: Record<string, string | number>;
  perNote: BulkEdit[];
  timestamp: number;
}

export type ApplyDirection = 'undo' | 'redo';

// 実行器: Command の適用方法はこのフックの外で定義する。
// 返り値の boolean は「全ノートに問題なく適用できたか」。
// 競合（文言が想定と違う等）を検知した場合は false を返し、履歴は巻き戻さない。
export type CommandApplier = (
  command: BulkCommand,
  direction: ApplyDirection,
) => Promise<boolean> | boolean;

const DEFAULT_MAX_HISTORY = 50;

export interface UseBulkEditHistoryOptions {
  maxHistory?: number;
  apply: CommandApplier;
}

export const useBulkEditHistory = ({
  apply,
  maxHistory = DEFAULT_MAX_HISTORY,
}: UseBulkEditHistoryOptions) => {
  const undoStackRef = useRef<BulkCommand[]>([]);
  const redoStackRef = useRef<BulkCommand[]>([]);
  // 再レンダ用のカウンタ（スタックは ref に持ち、状態はフラグのみ同期）
  const [, setRevision] = useState(0);
  const bump = useCallback(() => setRevision((r) => r + 1), []);

  const canUndo = undoStackRef.current.length > 0;
  const canRedo = redoStackRef.current.length > 0;

  // 新規コマンドを push。Redo スタックは無効化。上限超過時は古いものから捨てる。
  const pushCommand = useCallback(
    (command: BulkCommand) => {
      undoStackRef.current.push(command);
      if (undoStackRef.current.length > maxHistory) {
        undoStackRef.current.splice(
          0,
          undoStackRef.current.length - maxHistory,
        );
      }
      redoStackRef.current = [];
      bump();
    },
    [maxHistory, bump],
  );

  const undo = useCallback(async (): Promise<BulkCommand | null> => {
    const cmd = undoStackRef.current[undoStackRef.current.length - 1];
    if (!cmd) return null;
    const ok = await apply(cmd, 'undo');
    if (!ok) return null;
    undoStackRef.current.pop();
    redoStackRef.current.push(cmd);
    if (redoStackRef.current.length > maxHistory) {
      redoStackRef.current.splice(0, redoStackRef.current.length - maxHistory);
    }
    bump();
    return cmd;
  }, [apply, maxHistory, bump]);

  const redo = useCallback(async (): Promise<BulkCommand | null> => {
    const cmd = redoStackRef.current[redoStackRef.current.length - 1];
    if (!cmd) return null;
    const ok = await apply(cmd, 'redo');
    if (!ok) return null;
    redoStackRef.current.pop();
    undoStackRef.current.push(cmd);
    if (undoStackRef.current.length > maxHistory) {
      undoStackRef.current.splice(0, undoStackRef.current.length - maxHistory);
    }
    bump();
    return cmd;
  }, [apply, maxHistory, bump]);

  const clear = useCallback(() => {
    undoStackRef.current = [];
    redoStackRef.current = [];
    bump();
  }, [bump]);

  // ノートが削除された場合など、特定ノート ID を含む履歴を破棄する
  const invalidateForNote = useCallback(
    (noteId: string) => {
      const notHit = (c: BulkCommand) =>
        !c.perNote.some((p) => p.noteId === noteId);
      const before = undoStackRef.current.length + redoStackRef.current.length;
      undoStackRef.current = undoStackRef.current.filter(notHit);
      redoStackRef.current = redoStackRef.current.filter(notHit);
      const after = undoStackRef.current.length + redoStackRef.current.length;
      if (before !== after) bump();
    },
    [bump],
  );

  const peekUndo = (): BulkCommand | null =>
    undoStackRef.current[undoStackRef.current.length - 1] ?? null;
  const peekRedo = (): BulkCommand | null =>
    redoStackRef.current[redoStackRef.current.length - 1] ?? null;

  return {
    canUndo,
    canRedo,
    pushCommand,
    undo,
    redo,
    clear,
    invalidateForNote,
    peekUndo,
    peekRedo,
  };
};
