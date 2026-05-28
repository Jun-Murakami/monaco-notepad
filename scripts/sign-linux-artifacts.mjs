#!/usr/bin/env node

/**
 * Linux 配布物の整合性 / 真正性担保用フック。
 *
 * AI-Browser の scripts/sign-artifacts.cjs を Wails (CLI 引数受け取り型) に
 * 移植したもの。electron-builder の afterAllArtifactBuild に相当する立ち位置を
 * build_linux.sh の終端で果たす。
 *
 *   - SHA256SUMS     : 各成果物の SHA-256 (sha256sum -c 互換フォーマット)
 *   - SHA256SUMS.asc : SHA256SUMS への GPG デタッチ署名 (鍵があれば)
 *
 * ユーザー側検証手順:
 *   gpg --verify SHA256SUMS.asc SHA256SUMS   # 真正性
 *   sha256sum -c SHA256SUMS                  # 完全性
 *
 * 環境変数:
 *   GPG_SIGNING_KEY : 署名鍵 (鍵ID / フィンガープリント / メール)。省略時は既定鍵
 *   SKIP_GPG_SIGN   : 'true' で署名をスキップ (チェックサムのみ)
 *
 * 使い方:
 *   node scripts/sign-linux-artifacts.mjs build/bin/*.AppImage build/bin/*.deb
 *   (配布物本体 = .AppImage / .deb / .rpm / .tar.gz / .zip のみを対象に絞り込む)
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const DISTRIBUTABLE = /\.(AppImage|deb|rpm|snap|tar\.gz|tgz|zip|exe|dmg|pkg)$/i;

const args = process.argv.slice(2);
if (args.length === 0) {
	console.error('usage: sign-linux-artifacts.mjs <artifact> [...artifacts]');
	process.exit(1);
}

// 重複除外 + 配布物本体だけに絞る
const artifacts = Array.from(new Set(args.map((p) => resolve(p))))
	.filter((p) => {
		if (!existsSync(p)) {
			console.warn(`  • skip (not found): ${p}`);
			return false;
		}
		return DISTRIBUTABLE.test(basename(p));
	})
	.sort();

if (artifacts.length === 0) {
	console.warn('No distributable artifacts found. Nothing to sign.');
	process.exit(0);
}

const outDir = dirname(artifacts[0]);

// 全成果物が同じディレクトリ前提 (deb と AppImage の両方を build/bin に出すため OK)
for (const p of artifacts) {
	if (dirname(p) !== outDir) {
		console.error(
			`All artifacts must live in the same directory. Got ${p} alongside ${outDir}`,
		);
		process.exit(1);
	}
}

const sumsPath = resolve(outDir, 'SHA256SUMS');

const lines = artifacts.map((p) => {
	const hash = createHash('sha256').update(readFileSync(p)).digest('hex');
	return `${hash}  ${basename(p)}`;
});
writeFileSync(sumsPath, `${lines.join('\n')}\n`);
console.log(`  • Wrote SHA256SUMS (${artifacts.length} artifacts) → ${sumsPath}`);

if (process.env.SKIP_GPG_SIGN === 'true') {
	console.log('  • SKIP_GPG_SIGN=true → skipping GPG signature');
	process.exit(0);
}

// gpg の有無を確認 (無ければチェックサムのみで終了)
try {
	execFileSync('gpg', ['--version'], { stdio: 'ignore' });
} catch {
	console.warn('  • gpg not found → skipping signature (checksum only)');
	process.exit(0);
}

const ascPath = `${sumsPath}.asc`;
const gpgArgs = [
	'--batch',
	'--yes',
	'--armor',
	'--detach-sign',
	'--output',
	ascPath,
];
if (process.env.GPG_SIGNING_KEY) {
	gpgArgs.push('--local-user', process.env.GPG_SIGNING_KEY);
}
gpgArgs.push(sumsPath);

try {
	execFileSync('gpg', gpgArgs, { stdio: 'inherit' });
	console.log(`  • Wrote SHA256SUMS.asc (GPG detached signature) → ${ascPath}`);
} catch {
	console.warn(
		'  • GPG signing failed (no secret key?). Falling back to checksum only.',
	);
	process.exit(0);
}
