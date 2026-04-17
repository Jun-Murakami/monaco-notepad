import { describe, expect, it } from 'vitest';

import {
  applyEditsToString,
  buildReplacementEdits,
  compileSearchRegex,
  expandReplacement,
  extractLineAt,
  filterMatchesInRange,
  findAllMatches,
  isValidSearchPattern,
  offsetToLineColumn,
} from '../searchUtils';

describe('searchUtils', () => {
  describe('compileSearchRegex', () => {
    it('リテラル検索ではメタ文字をエスケープすること', () => {
      const re = compileSearchRegex({
        query: '1+1=2',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      expect(re).not.toBeNull();
      if (!re) throw new Error('regex failed');
      expect('1+1=2 and 1+1=3'.match(re)?.length).toBe(1);
    });

    it('大文字小文字区別オプションを反映すること', () => {
      const ci = compileSearchRegex({
        query: 'foo',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      if (!ci) throw new Error('regex failed');
      expect('FOO'.match(ci)).not.toBeNull();

      const cs = compileSearchRegex({
        query: 'foo',
        caseSensitive: true,
        wholeWord: false,
        useRegex: false,
      });
      if (!cs) throw new Error('regex failed');
      expect('FOO'.match(cs)).toBeNull();
    });

    it('単語一致オプションで部分一致を除外すること', () => {
      const re = compileSearchRegex({
        query: 'cat',
        caseSensitive: false,
        wholeWord: true,
        useRegex: false,
      });
      if (!re) throw new Error('regex failed');
      expect('cat'.match(re)).not.toBeNull();
      expect('catalog'.match(re)).toBeNull();
    });

    it('正規表現モードで後方参照を有効にできること', () => {
      const re = compileSearchRegex({
        query: '(\\w+)-\\1',
        caseSensitive: false,
        wholeWord: false,
        useRegex: true,
      });
      expect(re).not.toBeNull();
      if (!re) throw new Error('regex failed');
      expect('hello-hello'.match(re)?.[0]).toBe('hello-hello');
    });

    it('不正な正規表現では null を返すこと', () => {
      const re = compileSearchRegex({
        query: '(',
        caseSensitive: false,
        wholeWord: false,
        useRegex: true,
      });
      expect(re).toBeNull();
    });
  });

  describe('isValidSearchPattern', () => {
    it('空クエリは常に有効', () => {
      expect(
        isValidSearchPattern({
          query: '',
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        }),
      ).toBe(true);
    });
    it('不正な regex を無効判定', () => {
      expect(
        isValidSearchPattern({
          query: '(',
          caseSensitive: false,
          wholeWord: false,
          useRegex: true,
        }),
      ).toBe(false);
    });
  });

  describe('findAllMatches', () => {
    it('全ヒットを列挙し、オフセットが正しいこと', () => {
      const matches = findAllMatches('foo bar foo', {
        query: 'foo',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      expect(matches.map((m) => m.start)).toEqual([0, 8]);
      expect(matches.every((m) => m.matchText === 'foo')).toBe(true);
    });

    it('0 長マッチで無限ループしないこと', () => {
      const matches = findAllMatches('abc', {
        query: '^|$',
        caseSensitive: false,
        wholeWord: false,
        useRegex: true,
      });
      expect(matches.length).toBeLessThan(10);
    });

    it('キャプチャグループを保持すること', () => {
      const matches = findAllMatches('foo=1, bar=2', {
        query: '(\\w+)=(\\d+)',
        caseSensitive: false,
        wholeWord: false,
        useRegex: true,
      });
      expect(matches[0].groups).toEqual(['foo=1', 'foo', '1']);
      expect(matches[1].groups).toEqual(['bar=2', 'bar', '2']);
    });
  });

  describe('expandReplacement', () => {
    const match = {
      start: 0,
      end: 5,
      matchText: 'Hello',
      groups: ['Hello', 'Hel', 'lo'],
    };
    it('$& を全体一致に展開すること', () => {
      expect(expandReplacement(match, '[$&]')).toBe('[Hello]');
    });
    it('数値参照を展開すること', () => {
      expect(expandReplacement(match, '$2-$1')).toBe('lo-Hel');
    });
    it('$$ をリテラル $ にすること', () => {
      expect(expandReplacement(match, '$$1')).toBe('$1');
    });
  });

  describe('filterMatchesInRange', () => {
    it('範囲外のヒットを除外すること', () => {
      const ms = findAllMatches('abc abc abc', {
        query: 'abc',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      const filtered = filterMatchesInRange(ms, 3, 8);
      expect(filtered.length).toBe(1);
      expect(filtered[0].start).toBe(4);
    });
  });

  describe('offsetToLineColumn / extractLineAt', () => {
    it('改行越しでも正しく行列変換できること', () => {
      const text = 'line1\nline two\nthird';
      expect(offsetToLineColumn(text, 0)).toEqual({ line: 1, column: 1 });
      expect(offsetToLineColumn(text, 6)).toEqual({ line: 2, column: 1 });
      expect(offsetToLineColumn(text, 15)).toEqual({ line: 3, column: 1 });
    });

    it('extractLineAt が行本文とオフセットを返すこと', () => {
      const text = 'first\nsecond line\nthird';
      const info = extractLineAt(text, 13); // "line" の開始位置
      expect(info.line).toBe(2);
      expect(info.lineText).toBe('second line');
      expect(info.matchOffsetInLine).toBe(7);
    });
  });

  describe('buildReplacementEdits / applyEditsToString', () => {
    it('単純置換が正しく適用されること', () => {
      const text = 'foo bar foo';
      const matches = findAllMatches(text, {
        query: 'foo',
        caseSensitive: false,
        wholeWord: false,
        useRegex: false,
      });
      const edits = buildReplacementEdits(matches, 'baz', false);
      expect(applyEditsToString(text, edits)).toBe('baz bar baz');
    });

    it('正規表現モードで後方参照を置換に反映できること', () => {
      const text = 'foo=1, bar=2';
      const matches = findAllMatches(text, {
        query: '(\\w+)=(\\d+)',
        caseSensitive: false,
        wholeWord: false,
        useRegex: true,
      });
      const edits = buildReplacementEdits(matches, '$2:$1', true);
      expect(applyEditsToString(text, edits)).toBe('1:foo, 2:bar');
    });

    it('edits が逆順でもソートされて正しく適用されること', () => {
      const text = '0123456789';
      const edits = [
        { start: 7, end: 9, original: '78', replacement: 'XY' },
        { start: 2, end: 4, original: '23', replacement: 'AB' },
      ];
      expect(applyEditsToString(text, edits)).toBe('01AB456XY9');
    });

    it('空の edits で元文字列をそのまま返すこと', () => {
      expect(applyEditsToString('abc', [])).toBe('abc');
    });
  });
});
