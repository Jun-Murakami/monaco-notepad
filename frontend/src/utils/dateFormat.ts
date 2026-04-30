// ノートのタイムスタンプを OS のシステムロケールに従って整形するユーティリティ。
// UI 言語設定とは独立し、Intl.DateTimeFormat へ OS 由来の BCP47 ロケールを渡すことで
// その地域の慣習 (例: ja-JP の "2026/05/01"、en-US の "5/1/26") に従わせる。

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();
const dateTimeFormatterCache = new Map<string, Intl.DateTimeFormat>();

const buildFormatter = (
  locale: string | undefined,
  options: Intl.DateTimeFormatOptions,
): Intl.DateTimeFormat => {
  try {
    return new Intl.DateTimeFormat(locale || undefined, options);
  } catch {
    // 不正なロケール文字列の場合はランタイム既定にフォールバック
    return new Intl.DateTimeFormat(undefined, options);
  }
};

const getDateFormatter = (locale: string | undefined): Intl.DateTimeFormat => {
  const key = locale ?? '';
  const cached = dateFormatterCache.get(key);
  if (cached) return cached;
  const formatter = buildFormatter(locale, { dateStyle: 'short' });
  dateFormatterCache.set(key, formatter);
  return formatter;
};

const getDateTimeFormatter = (
  locale: string | undefined,
): Intl.DateTimeFormat => {
  const key = locale ?? '';
  const cached = dateTimeFormatterCache.get(key);
  if (cached) return cached;
  const formatter = buildFormatter(locale, {
    dateStyle: 'short',
    timeStyle: 'medium',
  });
  dateTimeFormatterCache.set(key, formatter);
  return formatter;
};

export const formatNoteDate = (
  value: string | undefined | null,
  locale: string | undefined,
): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return getDateFormatter(locale).format(date);
};

export const formatNoteDateTime = (
  value: string | undefined | null,
  locale: string | undefined,
): string => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return getDateTimeFormatter(locale).format(date);
};
