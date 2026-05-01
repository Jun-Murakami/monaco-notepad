import { describe, expect, it } from 'vitest';

import { formatNoteDate, formatNoteDateTime } from '../dateFormat';

// 注意: Intl.DateTimeFormat はホスト ICU 依存で各 OS の慣習出力に従う。
// ここでは「区切り文字の正規化」と「ja-JP / en-US で何かしら値が返る」ことに焦点を絞る。
describe('formatNoteDate', () => {
  it('空文字 / null / undefined では空文字を返す', () => {
    expect(formatNoteDate('', 'ja-JP')).toBe('');
    expect(formatNoteDate(null, 'ja-JP')).toBe('');
    expect(formatNoteDate(undefined, 'ja-JP')).toBe('');
  });

  it('不正な日時文字列では空文字を返す', () => {
    expect(formatNoteDate('not-a-date', 'ja-JP')).toBe('');
  });

  it('ja-JP の "/" 区切りを "." に置換する', () => {
    const out = formatNoteDate('2026-05-01T12:34:56Z', 'ja-JP');
    expect(out).not.toMatch(/\//);
    expect(out).toMatch(/\./);
  });

  it('en-US でも "/" を "." に置換する', () => {
    const out = formatNoteDate('2026-05-01T12:34:56Z', 'en-US');
    expect(out).not.toMatch(/\//);
    expect(out).toMatch(/\./);
  });

  it('不正なロケール文字列でもクラッシュせず文字列を返す', () => {
    const out = formatNoteDate('2026-05-01T12:34:56Z', '!!!invalid-locale!!!');
    expect(typeof out).toBe('string');
    expect(out.length).toBeGreaterThan(0);
  });
});

describe('formatNoteDateTime', () => {
  it('日時両方を含むこと（区切りはロケール依存のままで置換しない）', () => {
    const out = formatNoteDateTime('2026-05-01T12:34:56Z', 'en-US');
    expect(typeof out).toBe('string');
    // 時間表示が含まれる（数字が日付部以外にも複数組現れる想定）
    expect(out.length).toBeGreaterThan(8);
  });

  it('空 / 不正値は空文字', () => {
    expect(formatNoteDateTime('', 'ja-JP')).toBe('');
    expect(formatNoteDateTime('xxx', 'ja-JP')).toBe('');
  });
});
