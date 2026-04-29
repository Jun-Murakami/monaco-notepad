/**
 * モバイル版の依存パッケージ一覧と各ライセンス情報を抽出して
 * `src/data/licenses.json` に書き出す。
 *
 * デスクトップ版の `frontend/scripts/generate-licenses.mjs` と同じ思想。
 * 違いは出力先 (Metro が import で読める場所) のみ。
 *
 * 実行タイミング:
 *   - `npm install` 直後 (postinstall)
 *   - `npm run prebuild` / `preandroid` / `preios`
 *   - EAS Build 上では postinstall 経由で自動的に再生成される
 */
import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const mobileDir = resolve(__dirname, '..');
const outFile = resolve(mobileDir, 'src/data/licenses.json');

function generate() {
	console.log('[mobile] Generating dependency licenses...');
	mkdirSync(dirname(outFile), { recursive: true });
	try {
		const raw = execSync('npx --yes license-checker --json --production', {
			cwd: mobileDir,
			encoding: 'utf-8',
			stdio: ['pipe', 'pipe', 'pipe'],
		});
		const data = JSON.parse(raw);
		const licenses = Object.entries(data).map(([key, value]) => {
			const atIndex = key.lastIndexOf('@');
			const name = atIndex > 0 ? key.slice(0, atIndex) : key;
			const version = atIndex > 0 ? key.slice(atIndex + 1) : '';
			return {
				name,
				version,
				license: value.licenses || 'Unknown',
				repository: (value.repository || '')
					.replace(/^git\+/, '')
					.replace(/\.git$/, ''),
			};
		});
		licenses.sort((a, b) => a.name.localeCompare(b.name));
		writeFileSync(outFile, JSON.stringify(licenses, null, 2));
		console.log(`[mobile]  -> ${licenses.length} packages -> ${outFile}`);
	} catch (err) {
		console.warn(
			'[mobile] Warning: failed to generate mobile licenses:',
			err.message,
		);
		// 失敗しても import が壊れないように空配列で fallback。
		writeFileSync(outFile, '[]');
	}
}

generate();
