/**
 * Shiki の各言語 grammar を遅延 import するためのローダー表。
 *
 * Metro は dynamic import を「同一バンドル内のサブチャンク扱い」で展開するため、
 * import するモジュール自体は最終バンドルに含まれるが、JS 評価は loader が
 * 呼ばれた瞬間まで遅延される。すなわち起動時の grammar JSON parse コストを
 * 回避できる。
 *
 * key は **Shiki の language ID**（Monaco ID ではない）。Monaco ID から
 * Shiki ID へのマップは `languageMap.ts` を参照。
 */
import type { LanguageRegistration } from '@shikijs/types';

type LangLoader = () => Promise<LanguageRegistration[]>;

/**
 * Shiki language ID → 遅延 import ローダー。
 * `@shikijs/langs/<id>` の default export は `LanguageRegistration[]`。
 */
export const SHIKI_LANGUAGE_LOADERS: Record<string, LangLoader> = {
	abap: () => import('@shikijs/langs/abap').then((m) => m.default),
	apex: () => import('@shikijs/langs/apex').then((m) => m.default),
	bat: () => import('@shikijs/langs/bat').then((m) => m.default),
	bicep: () => import('@shikijs/langs/bicep').then((m) => m.default),
	clojure: () => import('@shikijs/langs/clojure').then((m) => m.default),
	coffee: () => import('@shikijs/langs/coffee').then((m) => m.default),
	cpp: () => import('@shikijs/langs/cpp').then((m) => m.default),
	csharp: () => import('@shikijs/langs/csharp').then((m) => m.default),
	css: () => import('@shikijs/langs/css').then((m) => m.default),
	cypher: () => import('@shikijs/langs/cypher').then((m) => m.default),
	dart: () => import('@shikijs/langs/dart').then((m) => m.default),
	docker: () => import('@shikijs/langs/docker').then((m) => m.default),
	elixir: () => import('@shikijs/langs/elixir').then((m) => m.default),
	fsharp: () => import('@shikijs/langs/fsharp').then((m) => m.default),
	go: () => import('@shikijs/langs/go').then((m) => m.default),
	graphql: () => import('@shikijs/langs/graphql').then((m) => m.default),
	handlebars: () => import('@shikijs/langs/handlebars').then((m) => m.default),
	hcl: () => import('@shikijs/langs/hcl').then((m) => m.default),
	html: () => import('@shikijs/langs/html').then((m) => m.default),
	ini: () => import('@shikijs/langs/ini').then((m) => m.default),
	java: () => import('@shikijs/langs/java').then((m) => m.default),
	javascript: () => import('@shikijs/langs/javascript').then((m) => m.default),
	julia: () => import('@shikijs/langs/julia').then((m) => m.default),
	kotlin: () => import('@shikijs/langs/kotlin').then((m) => m.default),
	less: () => import('@shikijs/langs/less').then((m) => m.default),
	liquid: () => import('@shikijs/langs/liquid').then((m) => m.default),
	lua: () => import('@shikijs/langs/lua').then((m) => m.default),
	markdown: () => import('@shikijs/langs/markdown').then((m) => m.default),
	mdx: () => import('@shikijs/langs/mdx').then((m) => m.default),
	mipsasm: () => import('@shikijs/langs/mipsasm').then((m) => m.default),
	'objective-c': () =>
		import('@shikijs/langs/objective-c').then((m) => m.default),
	pascal: () => import('@shikijs/langs/pascal').then((m) => m.default),
	perl: () => import('@shikijs/langs/perl').then((m) => m.default),
	php: () => import('@shikijs/langs/php').then((m) => m.default),
	powerquery: () => import('@shikijs/langs/powerquery').then((m) => m.default),
	powershell: () => import('@shikijs/langs/powershell').then((m) => m.default),
	proto: () => import('@shikijs/langs/proto').then((m) => m.default),
	pug: () => import('@shikijs/langs/pug').then((m) => m.default),
	python: () => import('@shikijs/langs/python').then((m) => m.default),
	r: () => import('@shikijs/langs/r').then((m) => m.default),
	razor: () => import('@shikijs/langs/razor').then((m) => m.default),
	rst: () => import('@shikijs/langs/rst').then((m) => m.default),
	ruby: () => import('@shikijs/langs/ruby').then((m) => m.default),
	rust: () => import('@shikijs/langs/rust').then((m) => m.default),
	scala: () => import('@shikijs/langs/scala').then((m) => m.default),
	scheme: () => import('@shikijs/langs/scheme').then((m) => m.default),
	scss: () => import('@shikijs/langs/scss').then((m) => m.default),
	shellscript: () =>
		import('@shikijs/langs/shellscript').then((m) => m.default),
	solidity: () => import('@shikijs/langs/solidity').then((m) => m.default),
	sparql: () => import('@shikijs/langs/sparql').then((m) => m.default),
	sql: () => import('@shikijs/langs/sql').then((m) => m.default),
	swift: () => import('@shikijs/langs/swift').then((m) => m.default),
	'system-verilog': () =>
		import('@shikijs/langs/system-verilog').then((m) => m.default),
	tcl: () => import('@shikijs/langs/tcl').then((m) => m.default),
	twig: () => import('@shikijs/langs/twig').then((m) => m.default),
	typescript: () => import('@shikijs/langs/typescript').then((m) => m.default),
	typespec: () => import('@shikijs/langs/typespec').then((m) => m.default),
	vb: () => import('@shikijs/langs/vb').then((m) => m.default),
	wgsl: () => import('@shikijs/langs/wgsl').then((m) => m.default),
	xml: () => import('@shikijs/langs/xml').then((m) => m.default),
	yaml: () => import('@shikijs/langs/yaml').then((m) => m.default),
};

/**
 * Shiki が当該 ID の grammar を持っているかどうか。
 * （`plaintext` 等の SpecialLanguage は loader を持たないが Shiki が直接扱うので true 扱い）
 */
export function hasShikiLanguage(shikiId: string): boolean {
	if (shikiId === 'plaintext' || shikiId === 'text') return true;
	return shikiId in SHIKI_LANGUAGE_LOADERS;
}
