#!/usr/bin/env node
// wails.json の productVersion を正として、
// frontend/package.json と mobile/package.json の version を揃える。
// ビルドスクリプト (build.ps1 / build_mac.sh) から呼ばれる。

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..');

const wailsPath = join(repoRoot, 'wails.json');
const targets = [
	join(repoRoot, 'frontend', 'package.json'),
	join(repoRoot, 'mobile', 'package.json'),
];

const wails = JSON.parse(readFileSync(wailsPath, 'utf8'));
const version = wails?.info?.productVersion;
if (!version || typeof version !== 'string') {
	console.error('sync-version: wails.json の info.productVersion が見つかりません');
	process.exit(1);
}

let changed = 0;
for (const file of targets) {
	const raw = readFileSync(file, 'utf8');
	const pkg = JSON.parse(raw);
	if (pkg.version === version) continue;

	const prev = pkg.version;
	pkg.version = version;
	// 元ファイルの末尾改行を保持する
	const trailing = raw.endsWith('\n') ? '\n' : '';
	writeFileSync(file, `${JSON.stringify(pkg, null, 2)}${trailing}`);
	console.log(`sync-version: ${file} ${prev} -> ${version}`);
	changed++;
}

if (changed === 0) {
	console.log(`sync-version: all package.json already at v${version}`);
}
