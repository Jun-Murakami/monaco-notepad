// バイナリファイル判定ロジック
export const isBinaryFile = (content: string): boolean => {
  // BiomeのnoControlCharactersInRegexに合わせ、正規表現は使わずコードポイントで判定する
  const hasControlChars = Array.from(content).some((char) => {
    const code = char.charCodeAt(0);
    return (
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x0e && code <= 0x1f) ||
      code === 0x7f
    );
  });
  return (
    hasControlChars ||
    content.includes('\x00') || // ヌル文字チェック
    content.length > 1024 * 1024
  ); // 1MB以上のファイルは安全のためブロック
};
