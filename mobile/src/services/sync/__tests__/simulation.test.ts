import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FakeOp } from '@/test/fakeDrive';
import { FakeDrive } from '@/test/fakeDrive';
import { MobileDevice } from '@/test/mobileDevice';
import { normalizeNoteList } from '../codec';
import type { NoteList } from '../types';

// フォルダ ID を決定的にする（乱数の UUID だと同じシードでも展開が変わり再現できない）
let uuidSeq = 0;
vi.mock('@/utils/uuid', () => ({
	uuidv4: () => `folder-${String(++uuidSeq).padStart(4, '0')}`,
}));

/**
 * シード付きランダム・シミュレーション（docs/sync-engine-v3.md §9 L3）。
 *
 * 複数端末がランダムにノートの作成・編集・削除・フォルダ移動・並び替え・アーカイブ・
 * フォルダごとのアーカイブ / 削除を行い、ランダムなタイミングで同期する。端末はオフラインになったり、
 * 連携を解除・再接続したり、アプリを再起動したりもする。同期中の任意のリクエストの直前に別端末の操作と
 * 同期を割り込ませ、一時的な障害や通信断も注入する。全端末が静止したあと、次の不変条件を検証する:
 *
 *   1. 収束: 全端末のノート一覧（構造・順序・所属）と本文、クラウドの内容が一致する
 *   2. 最新の編集が勝つ: 残っている各ノートの内容は、全端末の書き込みのうち最も新しいもの
 *   3. データ喪失なし: 誰も削除していないノートは必ず残っている
 *   4. 不明ノートフォルダは現れない / 構造が壊れていない
 *   5. 復活しない: Drive から削除されたノートが、削除前からあった版で書き戻されない
 *   6. 黙って消えない: ユーザーが作った版は、最終版として残る / それを見た上で編集・削除された /
 *      競合バックアップに残る、のいずれか
 *
 * 失敗したら表示されるシードで `SEEDS` を置き換えれば同じ展開を再現できる。
 */

// 規模は環境変数で拡大できる（例: SIM_SEEDS=400 SIM_STEPS=80 SIM_DEVICES=4）
const DEVICE_COUNT = Number(process.env.SIM_DEVICES ?? 3);
const STEPS = Number(process.env.SIM_STEPS ?? 45);
const SEEDS = process.env.SIM_SEED
	? [Number(process.env.SIM_SEED)]
	: Array.from(
			{ length: Number(process.env.SIM_SEEDS ?? 40) },
			(_, i) => 1000 + i,
		);

function mulberry32(seed: number): () => number {
	let a = seed;
	return () => {
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

interface Write {
	content: string;
	title: string;
	archived: boolean;
	modifiedTime: string;
	device?: string;
	/** 同じ端末がその後ノートを削除した（= その端末の版はユーザーが捨てた）。 */
	discarded?: boolean;
}

/** 版の識別子（同じ版は端末をまたいでも同じ値になる）。 */
function versionKey(
	id: string,
	n: { content: string; archived: boolean; modifiedTime: string },
): string {
	return `${id}|${n.content}|${n.archived}|${n.modifiedTime}`;
}

/**
 * ユーザーから見た状態（modifiedTime を除く）。アーカイブして戻すなど、同じ状態に戻った版は
 * 「失われた」ことにならないので、黙って消えないかの検証はこちらで比べる。
 */
function stateKey(
	id: string,
	n: { title: string; content: string; archived: boolean },
): string {
	return `${id}|${n.title}|${n.content}|${n.archived}`;
}

class Model {
	readonly writes = new Map<string, Write[]>();
	readonly created = new Set<string>();
	readonly deleted = new Set<string>();
	/** それを手元に持った状態で編集された状態（= ユーザーが見た上で上書きした。stateKey）。 */
	readonly superseded = new Set<string>();
	/** それを手元に持った状態で削除された状態（stateKey）。 */
	readonly deletedVersions = new Set<string>();
	/**
	 * noteId -> 端末 -> その端末がノートを削除した時点の Drive 履歴の位置。
	 * それ以前にその端末が公開した版は、ユーザーが削除によって捨てたものとして扱う。
	 */
	readonly deletedAt = new Map<string, Map<string, number>>();

	constructor(readonly historyLength: () => number) {}

	markDeleted(id: string, device: string): void {
		this.deleted.add(id);
		this.discard(id, device);
		const byDevice = this.deletedAt.get(id) ?? new Map<string, number>();
		byDevice.set(device, this.historyLength());
		this.deletedAt.set(id, byDevice);
	}

	record(id: string, device: string, w: Write): void {
		const list = this.writes.get(id) ?? [];
		list.push({ ...w, device });
		this.writes.set(id, list);
	}

	/** 端末がノートを削除した: その端末のそれまでの版は捨てられた。 */
	discard(id: string, device: string): void {
		for (const w of this.writes.get(id) ?? []) {
			if (w.device === device) w.discarded = true;
		}
	}

	/** 捨てられていない書き込みのうち最新のもの（= 最終的に残るべき版）。 */
	latest(id: string): Write | undefined {
		const list = (this.writes.get(id) ?? []).filter((w) => !w.discarded);
		return [...list].sort((a, b) =>
			a.modifiedTime < b.modifiedTime ? 1 : -1,
		)[0];
	}
}

const SYNC_OPS: FakeOp[] = [
	'files.list',
	'files.download',
	'files.create',
	'files.update',
	'files.delete',
];

async function localOp(
	d: MobileDevice,
	rand: () => number,
	model: Model,
	ids: { note: number; folder: number },
	log: string[],
): Promise<void> {
	const pick = <T>(arr: T[]): T | undefined =>
		arr.length === 0 ? undefined : arr[Math.floor(rand() * arr.length)];
	const list = d.list();
	const activeNotes = list.notes.filter((n) => !n.archived);
	/** 操作前の手元の版を「見た上で上書き / 削除した」として記録する。 */
	const seen = async (id: string, into: Set<string>) => {
		const before = await d.readNote(id);
		if (before) into.add(stateKey(id, before));
	};
	const roll = rand();
	if (roll < 0.04) {
		// フォルダごとアーカイブ / アーカイブ済みフォルダを配下ごと削除
		const folder = pick(list.folders);
		if (!folder) return;
		const inFolder = list.notes.filter((n) => n.folderId === folder.id);
		if (!folder.archived) {
			for (const n of inFolder)
				if (!n.archived) await seen(n.id, model.superseded);
			await d.archiveFolder(folder.id);
			for (const n of inFolder) {
				const note = await d.readNote(n.id);
				if (note && !n.archived) model.record(n.id, d.deviceId, note);
			}
			log.push(`${d.deviceId}: archiveFolder ${folder.id}`);
		} else {
			for (const n of inFolder) {
				await seen(n.id, model.deletedVersions);
				model.markDeleted(n.id, d.deviceId);
			}
			await d.deleteArchivedFolder(folder.id);
			log.push(`${d.deviceId}: deleteArchivedFolder ${folder.id}`);
		}
	} else if (roll < 0.22) {
		const id = `N${++ids.note}`;
		const note = await d.createNoteOffline({
			id,
			title: `t-${id}`,
			content: `c-${id}-0`,
		});
		model.created.add(id);
		model.record(id, d.deviceId, note);
		log.push(`${d.deviceId}: create ${id}`);
	} else if (roll < 0.5) {
		const target = pick(list.notes);
		if (!target) return;
		const content = `c-${target.id}-${d.deviceId}-${Math.floor(rand() * 1e6)}`;
		await seen(target.id, model.superseded);
		const note = await d.editNoteOffline(target.id, { content });
		model.record(target.id, d.deviceId, note);
		log.push(`${d.deviceId}: edit ${target.id}`);
	} else if (roll < 0.58) {
		const target = pick(list.notes);
		if (!target) return;
		await seen(target.id, model.deletedVersions);
		await d.deleteNoteOffline(target.id);
		model.markDeleted(target.id, d.deviceId);
		log.push(`${d.deviceId}: delete ${target.id}`);
	} else if (roll < 0.66) {
		const id = await d.createFolder(`F${++ids.folder}`);
		log.push(`${d.deviceId}: createFolder ${id}`);
	} else if (roll < 0.76) {
		const target = pick(activeNotes);
		if (!target) return;
		const folder = pick([
			...list.folders.filter((f) => !f.archived).map((f) => f.id),
			'',
		]);
		await d.moveNoteToFolder(target.id, folder ?? '');
		log.push(`${d.deviceId}: move ${target.id} -> ${folder || 'top'}`);
	} else if (roll < 0.88) {
		const order = [...list.topLevelOrder];
		if (order.length < 2) return;
		const [item] = order.splice(Math.floor(rand() * order.length), 1);
		order.splice(Math.floor(rand() * (order.length + 1)), 0, item);
		await d.reorderTopLevel(order);
		log.push(`${d.deviceId}: reorder ${item.type}:${item.id}`);
	} else {
		const target = pick(list.notes);
		if (!target) return;
		await seen(target.id, model.superseded);
		const note = await d.setArchived(target.id, !target.archived);
		model.record(target.id, d.deviceId, note);
		log.push(
			`${d.deviceId}: ${note.archived ? 'archive' : 'unarchive'} ${target.id}`,
		);
	}
}

function canonical(list: NoteList): string {
	const { version: _v, ...rest } = list;
	return JSON.stringify({
		...rest,
		notes: rest.notes.map((n) => ({
			id: n.id,
			folderId: n.folderId,
			archived: n.archived,
			title: n.title,
			contentHash: n.contentHash,
		})),
	});
}

function checkStructure(list: NoteList, label: string): void {
	const ids = list.notes.map((n) => n.id);
	expect(new Set(ids).size, `${label}: notes に重複`).toBe(ids.length);
	const folderIds = new Set(list.folders.map((f) => f.id));
	const noteById = new Map(list.notes.map((n) => [n.id, n]));
	const folderById = new Map(list.folders.map((f) => [f.id, f]));
	for (const n of list.notes) {
		if (n.folderId)
			expect(
				folderIds.has(n.folderId),
				`${label}: ${n.id} の所属フォルダが無い`,
			).toBe(true);
	}
	for (const [order, archived] of [
		[list.topLevelOrder, false],
		[list.archivedTopLevelOrder, true],
	] as const) {
		const keys = order.map((i) => `${i.type}:${i.id}`);
		expect(new Set(keys).size, `${label}: 順序に重複`).toBe(keys.length);
		for (const item of order) {
			if (item.type === 'note') {
				const n = noteById.get(item.id);
				expect(
					n && n.folderId === '' && n.archived === archived,
					`${label}: 順序の不正なノート ${item.id}`,
				).toBe(true);
			} else {
				expect(
					folderById.get(item.id)?.archived,
					`${label}: 順序の不正なフォルダ ${item.id}`,
				).toBe(archived);
			}
		}
	}
	for (const n of list.notes) {
		if (n.folderId) continue;
		const order = n.archived ? list.archivedTopLevelOrder : list.topLevelOrder;
		expect(
			order.some((i) => i.type === 'note' && i.id === n.id),
			`${label}: ${n.id} が順序に無い`,
		).toBe(true);
	}
	expect(
		list.folders.map((f) => f.name),
		`${label}: 不明ノートが現れた`,
	).not.toContain('不明ノート');
}

async function runSimulation(seed: number): Promise<void> {
	uuidSeq = 0;
	const drive = new FakeDrive();
	vi.stubGlobal('fetch', drive.fetch);
	const rand = mulberry32(seed);
	const model = new Model(() => drive.noteHistory.length);
	const ids = { note: 0, folder: 0 };
	const log: string[] = [];
	if (process.env.SIM_DEBUG) {
		const push = log.push.bind(log);
		log.push = (...items: string[]) => {
			for (const item of items)
				process.stdout.write(`[sim] ${item}
`);
			return push(...items);
		};
	}
	const devices: MobileDevice[] = [];
	for (let i = 0; i < DEVICE_COUNT; i++) {
		const d = new MobileDevice(drive, `dev${i}`);
		await d.boot();
		await d.connect();
		devices.push(d);
	}
	const pickDevice = () => devices[Math.floor(rand() * devices.length)];
	// 同期中の端末（入れ子の割り込みで同じ端末の同期を再入させないため）
	const syncing = new Set<MobileDevice>();
	const offline = new Set<MobileDevice>();
	const syncDevice = async (d: MobileDevice) => {
		// 連携解除中はポーリングが動いていない
		if (!d.connected) return;
		syncing.add(d);
		try {
			await d.sync();
		} finally {
			syncing.delete(d);
		}
	};
	/** 端末のライフサイクル: オフライン切り替え / 連携解除・再接続 / アプリ再起動。 */
	const lifecycleOp = async (d: MobileDevice) => {
		const roll = rand();
		if (roll < 0.45) {
			if (offline.has(d)) {
				offline.delete(d);
				d.goOnline();
				log.push(`${d.deviceId}: online`);
			} else {
				offline.add(d);
				d.goOffline();
				log.push(`${d.deviceId}: offline`);
			}
		} else if (roll < 0.75) {
			if (d.connected) {
				await d.signOut();
				log.push(`${d.deviceId}: signOut`);
			} else {
				await d.signIn();
				log.push(`${d.deviceId}: signIn`);
			}
		} else {
			await d.restart();
			log.push(`${d.deviceId}: restart`);
		}
	};

	try {
		for (let step = 0; step < STEPS; step++) {
			const d = pickDevice();
			if (rand() < 0.08) {
				await lifecycleOp(d);
				continue;
			}
			if (rand() < 0.55) {
				await localOp(d, rand, model, ids, log);
				continue;
			}
			if (!d.connected) continue;
			// 同期。一定確率で、同期中の任意のリクエストの直前に別端末の操作 + 同期を割り込ませる
			drive.clearInterceptors();
			if (rand() < 0.35) {
				const other = devices.filter((x) => x !== d)[
					Math.floor(rand() * (devices.length - 1))
				];
				let countdown = 1 + Math.floor(rand() * 12);
				drive.beforeRequest(
					(r) => r.deviceId === d.deviceId && --countdown === 0,
					async () => {
						log.push(
							`  ${other.deviceId} interleaves into ${d.deviceId}'s sync`,
						);
						await localOp(other, rand, model, ids, log);
						if (!syncing.has(other)) await syncDevice(other).catch(() => {});
					},
				);
			}
			if (rand() < 0.15) {
				const op = SYNC_OPS[Math.floor(rand() * SYNC_OPS.length)];
				drive.failWhen((r) => r.deviceId === d.deviceId && r.op === op, 503, 1);
				log.push(`  inject 503 on ${d.deviceId} ${op}`);
			}
			// 同期の途中で通信が切れる（その後の同期は失敗し続ける。戻るのは lifecycleOp）
			let cut = false;
			if (!offline.has(d) && rand() < 0.08) {
				let countdown = 1 + Math.floor(rand() * 12);
				drive.beforeRequest(
					(r) => r.deviceId === d.deviceId && --countdown === 0,
					() => {
						cut = true;
						offline.add(d);
						d.goOffline();
					},
				);
			}
			log.push(`${d.deviceId}: sync`);
			await syncDevice(d).catch((e) =>
				log.push(`  ${d.deviceId} sync failed: ${e}`),
			);
			if (cut) log.push(`  ${d.deviceId} lost connection mid-sync`);
		}

		// 静止化: 全端末をオンライン・接続状態に戻し、割り込み・障害を外して、
		// 全端末が変化しなくなるまで同期する
		drive.clearInterceptors();
		for (const d of devices) {
			d.goOnline();
			if (!d.connected) await d.signIn();
		}
		let converged = false;
		let lists: string[] = [];
		let pending: boolean[] = [];
		for (let round = 0; round < 6 && !converged; round++) {
			for (const d of devices) {
				const report = await d.sync();
				log.push(`quiesce r${round} ${d.deviceId}: ${JSON.stringify(report)}`);
			}
			lists = devices.map((d) => canonical(d.list()));
			pending = await Promise.all(devices.map((d) => d.hasPendingWork()));
			converged =
				lists.every((l) => l === lists[0]) && pending.every((p) => !p);
		}
		if (!converged) {
			log.push(`pending: ${JSON.stringify(pending)}`);
			devices.forEach((d, i) => {
				log.push(`${d.deviceId} state: ${JSON.stringify(d.state.snapshot())}`);
				log.push(`${d.deviceId} list: ${lists[i]}`);
			});
		}
		expect(converged, '端末が収束しない').toBe(true);

		// クラウドの noteList も同じ
		const listFile = [...drive.files.values()].find(
			(f) => f.name === 'noteList_v2.json',
		);
		expect(listFile).toBeDefined();
		const cloudList = normalizeNoteList(JSON.parse(listFile?.content ?? '{}'));
		expect(canonical(cloudList)).toBe(canonical(devices[0].list()));

		const finalList = devices[0].list();
		for (const d of devices) checkStructure(d.list(), d.deviceId);

		const existing = new Set(finalList.notes.map((n) => n.id));
		for (const id of model.created) {
			if (!model.deleted.has(id))
				expect(existing.has(id), `誰も削除していない ${id} が消えた`).toBe(
					true,
				);
		}
		// 最新の版が勝つ: Drive に公開された版（最後に Drive から消えた後のもの）のうち、
		// modifiedTime が最も新しい版が最終的に全端末・Drive に残っていること。
		// 同期は状態ベースなので、公開されずに上書き・削除されたローカルの途中状態は対象外。
		const newestPublished = (id: string) => {
			const history = drive.noteHistory.filter((h) => h.name === `${id}.json`);
			const lastGone = history.map((h) => h.kind).lastIndexOf('gone');
			let newest:
				| { content: string; archived: boolean; modifiedTime: string }
				| undefined;
			for (const h of history.slice(lastGone + 1)) {
				if (h.kind !== 'upload' || !h.content) continue;
				// 公開した端末がその後ノートを削除していれば、その版はユーザーが捨てたもの
				const deletedAt = h.deviceId
					? model.deletedAt.get(id)?.get(h.deviceId)
					: undefined;
				if (deletedAt !== undefined && drive.noteHistory.indexOf(h) < deletedAt)
					continue;
				const v = JSON.parse(h.content) as {
					content: string;
					archived: boolean;
					modifiedTime: string;
				};
				if (!newest || v.modifiedTime >= newest.modifiedTime) newest = v;
			}
			return newest;
		};
		// 復活しない: Drive から消えた後に、消える前からあった版が書き戻されていない
		const versionOf = (id: string, raw: string) =>
			versionKey(
				id,
				JSON.parse(raw) as {
					content: string;
					archived: boolean;
					modifiedTime: string;
				},
			);
		const byNote = new Map<string, typeof drive.noteHistory>();
		for (const h of drive.noteHistory) {
			const list = byNote.get(h.name) ?? [];
			list.push(h);
			byNote.set(h.name, list);
		}
		for (const [name, history] of byNote) {
			const id = name.replace(/\.json$/, '');
			const before = new Set<string>();
			let gone = false;
			for (const h of history) {
				if (h.kind === 'gone') {
					gone = true;
					continue;
				}
				if (!h.content) continue;
				const v = versionOf(id, h.content);
				if (gone && before.has(v)) {
					throw new Error(
						`${id}: 削除後に削除前の版が書き戻された（${h.deviceId}）: ${v}`,
					);
				}
				if (!gone) before.add(v);
			}
		}

		// 黙って消えない: ユーザーが作った版は、最終版 / 見た上での編集・削除 / バックアップ のどれか
		const finalVersions = new Set<string>();
		for (const id of existing) {
			const note = await devices[0].readNote(id);
			if (note) finalVersions.add(stateKey(id, note));
		}
		const backedUp = new Set<string>();
		for (const d of devices)
			for (const b of d.backups) backedUp.add(stateKey(b.note.id, b.note));
		for (const [id, writes] of model.writes) {
			for (const w of writes) {
				const v = stateKey(id, w);
				const accounted =
					finalVersions.has(v) ||
					model.superseded.has(v) ||
					model.deletedVersions.has(v) ||
					backedUp.has(v);
				expect(accounted, `${w.device} が作った版が黙って消えた: ${v}`).toBe(
					true,
				);
			}
		}

		for (const id of existing) {
			const want = newestPublished(id);
			expect(want, `${id} が Drive に公開されていない`).toBeDefined();
			for (const d of devices) {
				const note = await d.readNote(id);
				expect(note?.content, `${d.deviceId}: ${id} が最新の版ではない`).toBe(
					want?.content,
				);
				expect(
					note?.archived,
					`${d.deviceId}: ${id} の archived が最新の版ではない`,
				).toBe(want?.archived);
			}
			const cloudFile = [...drive.files.values()].find(
				(f) => f.name === `${id}.json`,
			);
			expect(
				JSON.parse(cloudFile?.content ?? '{}').content,
				`Drive 上の ${id}`,
			).toBe(want?.content);
		}
	} catch (e) {
		if (process.env.SIM_DEBUG) {
			for (const d of devices) {
				const backups = d.backups.map((b) => [
					b.kind,
					versionKey(b.note.id, b.note),
				]);
				log.push(`${d.deviceId} backups: ${JSON.stringify(backups)}`);
			}
			for (const h of drive.noteHistory) {
				const v = h.content
					? versionKey(
							h.name,
							JSON.parse(h.content) as {
								content: string;
								archived: boolean;
								modifiedTime: string;
							},
						)
					: '';
				log.push(`history ${h.name} ${h.kind} ${h.deviceId ?? ''} ${v}`);
			}
		}
		console.error(`simulation seed=${seed} failed. log:\n${log.join('\n')}`);
		throw e;
	}
}

describe('ランダム・シミュレーション（複数モバイル端末）', () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it.each(SEEDS)(
		'seed %i',
		async (seed) => {
			await runSimulation(seed);
		},
		60_000,
	);
});
