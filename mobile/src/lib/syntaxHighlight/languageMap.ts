/**
 * Monaco Editor の language ID と Shiki (TextMate grammar) の対応表。
 *
 * モバイルでは Shiki でハイライトするが、note.language には
 * デスクトップで選択された Monaco ID がそのまま入ってくる可能性がある。
 * ここで Monaco ID → Shiki ID にマップし、未対応のものは 'plaintext' に倒す。
 *
 * 「未対応」(= UNSUPPORTED_MONACO_IDS) はモバイルの言語ピッカーから除外するが、
 * デスクトップで選択された場合は note.language を**書き換えずそのまま保持**し、
 * 表示だけ plaintext フォールバックにする。
 */
import { MONACO_LANGUAGE_IDS } from '@/constants/monacoLanguages';

/**
 * Monaco の language ID → Shiki の language ID へのマップ。
 * 一致するものは省略（identity）。SQL 系方言は `sql` にフォールバック、
 * pascaligo は `pascal` にフォールバックする。
 */
const MONACO_TO_SHIKI: Record<string, string> = {
	plaintext: 'plaintext',
	dockerfile: 'docker',
	mips: 'mipsasm',
	'objective-c': 'objective-c',
	protobuf: 'proto',
	restructuredtext: 'rst',
	shell: 'shellscript',
	systemverilog: 'system-verilog',
	// SQL 方言は Shiki の sql で代替する。色付けの精度はやや落ちるが
	// 何も色が付かないより圧倒的にマシ。
	mysql: 'sql',
	pgsql: 'sql',
	redshift: 'sql',
	redis: 'sql',
	msdax: 'sql',
	// Pascal 系
	pascaligo: 'pascal',
};

/**
 * Shiki に対応する grammar が存在しない Monaco language ID。
 * モバイルピッカーから除外、表示は plaintext。
 */
export const UNSUPPORTED_MONACO_IDS = new Set<string>([
	'azcli',
	'cameligo',
	'csp',
	'ecl',
	'flow9',
	'freemarker2',
	'lexon',
	'm3',
	'pla',
	'postiats',
	'qsharp',
	'sb',
	'sophia',
	'st',
]);

/**
 * モバイル UI のピッカーに表示する language ID 一覧。
 * Monaco の全 ID から UNSUPPORTED を除いたもの。
 */
export const SUPPORTED_MONACO_IDS = MONACO_LANGUAGE_IDS.filter(
	(id) => !UNSUPPORTED_MONACO_IDS.has(id),
);

/**
 * Monaco language ID を Shiki が解釈できる ID に変換する。
 * 未対応は 'plaintext' に倒す。
 */
export function toShikiLanguage(monacoId: string | undefined | null): string {
	if (!monacoId) return 'plaintext';
	if (UNSUPPORTED_MONACO_IDS.has(monacoId)) return 'plaintext';
	return MONACO_TO_SHIKI[monacoId] ?? monacoId;
}

/**
 * 当該 Monaco ID がモバイルでハイライト可能かどうか。
 * UI 側で「ピッカーに含めるか」の判定に使う。
 */
export function isMonacoLanguageSupportedOnMobile(id: string): boolean {
	return !UNSUPPORTED_MONACO_IDS.has(id);
}
