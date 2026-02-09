// バイナリファイル判定ロジック
export const isBinaryFile = (content: string): boolean => {
  // 非表示文字・制御文字を含むかチェック（閾値は調整可能）
  const controlChars = /[\x00-\x08\x0E-\x1F\x7F]/;
  return (
    controlChars.test(content) ||
    content.includes('\x00') || // ヌル文字チェック
    content.length > 1024 * 1024
  ); // 1MB以上のファイルは安全のためブロック
};
