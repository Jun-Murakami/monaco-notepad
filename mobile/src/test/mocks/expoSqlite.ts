/**
 * expo-sqlite の in-memory モック。
 *
 * OperationQueue が使う SQL サブセットだけを解釈する簡易エンジン。
 * - CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 * - INSERT INTO t (cols) VALUES (?)
 * - DELETE FROM t [WHERE ...]
 * - UPDATE t SET col = ? [, col = ?] WHERE ...
 * - SELECT * | COUNT(*) as c | cols FROM t [WHERE ...] [ORDER BY ...] [LIMIT n]
 * - WHERE 句は AND 連結の { col = ? } / { col != ? } / { col IN ('a','b',...) } のみ
 */

type Value = string | number | null;
type Row = Record<string, Value>;

interface Table {
	columns: string[];
	autoIncrement: number;
	rows: Row[];
}

class MockDatabase {
	private tables = new Map<string, Table>();

	async execAsync(sql: string): Promise<void> {
		const stmts = splitStatements(sql);
		for (const stmt of stmts) this.execDDL(stmt);
	}

	async runAsync(sql: string, params: Value[] = []): Promise<void> {
		this.execDML(sql.trim(), params);
	}

	async getFirstAsync<T = Row>(sql: string, params: Value[] = []): Promise<T | null> {
		const rows = this.selectRows(sql.trim(), params);
		return (rows[0] as unknown as T) ?? null;
	}

	async getAllAsync<T = Row>(sql: string, params: Value[] = []): Promise<T[]> {
		return this.selectRows(sql.trim(), params) as unknown as T[];
	}

	async withTransactionAsync(fn: () => Promise<void>): Promise<void> {
		await fn();
	}

	private execDDL(stmt: string): void {
		const up = stmt.toUpperCase();
		if (up.startsWith('CREATE TABLE IF NOT EXISTS')) this.parseCreateTable(stmt);
	}

	private parseCreateTable(stmt: string): void {
		const m = stmt.match(/CREATE TABLE IF NOT EXISTS\s+(\w+)\s*\(([\s\S]+)\)\s*$/i);
		if (!m) return;
		const name = m[1];
		if (this.tables.has(name)) return;
		const cols = m[2]
			.split(',')
			.map((c) => c.trim().split(/\s+/)[0])
			.filter(Boolean);
		this.tables.set(name, { columns: cols, rows: [], autoIncrement: 0 });
	}

	private execDML(sql: string, params: Value[]): void {
		const up = sql.toUpperCase();
		if (up.startsWith('INSERT INTO')) return this.execInsert(sql, params);
		if (up.startsWith('DELETE FROM')) return this.execDelete(sql, params);
		if (up.startsWith('UPDATE ')) return this.execUpdate(sql, params);
	}

	private execInsert(sql: string, params: Value[]): void {
		const m = sql.match(
			/INSERT INTO\s+(\w+)\s*\(([^)]+)\)\s*VALUES\s*\(([^)]+)\)/i,
		);
		if (!m) return;
		const table = this.getTable(m[1]);
		const cols = m[2].split(',').map((c) => c.trim());
		const row: Row = {};
		for (let i = 0; i < cols.length; i++) row[cols[i]] = params[i] ?? null;
		if (!('id' in row) && table.columns.includes('id')) {
			table.autoIncrement += 1;
			row.id = table.autoIncrement;
		}
		if (typeof row.id === 'number' && row.id > table.autoIncrement) {
			table.autoIncrement = row.id;
		}
		table.rows.push(row);
	}

	private execDelete(sql: string, params: Value[]): void {
		const m = sql.match(/DELETE FROM\s+(\w+)(?:\s+WHERE\s+(.+))?$/i);
		if (!m) return;
		const table = this.getTable(m[1]);
		if (!m[2]) {
			table.rows = [];
			return;
		}
		const pred = compilePredicate(m[2], params);
		table.rows = table.rows.filter((r) => !pred(r));
	}

	private execUpdate(sql: string, params: Value[]): void {
		const m = sql.match(/UPDATE\s+(\w+)\s+SET\s+(.+?)\s+WHERE\s+(.+)$/i);
		if (!m) return;
		const table = this.getTable(m[1]);
		const assignments = m[2].split(',').map((a) => a.trim());
		const setParams = params.slice(0, assignments.length);
		const whereParams = params.slice(assignments.length);
		const pred = compilePredicate(m[3], whereParams);
		for (const row of table.rows) {
			if (!pred(row)) continue;
			for (let i = 0; i < assignments.length; i++) {
				const col = assignments[i].split('=')[0].trim();
				row[col] = setParams[i] ?? null;
			}
		}
	}

	private selectRows(sql: string, params: Value[]): Row[] {
		const m = sql.match(
			/SELECT\s+(.+?)\s+FROM\s+(\w+)(?:\s+WHERE\s+(.+?))?(?:\s+ORDER BY\s+(.+?))?(?:\s+LIMIT\s+(\d+))?\s*$/i,
		);
		if (!m) return [];
		const table = this.getTable(m[2]);
		let rows = table.rows.slice();
		if (m[3]) {
			const pred = compilePredicate(m[3], params);
			rows = rows.filter(pred);
		}
		if (m[4]) {
			const specs = m[4]
				.split(',')
				.map((s) => s.trim().split(/\s+/))
				.map(([col, dir]) => ({ col, dir: (dir ?? 'ASC').toUpperCase() }));
			rows.sort((a, b) => {
				for (const { col, dir } of specs) {
					const av = a[col];
					const bv = b[col];
					if (av === bv) continue;
					const cmp = (av ?? 0) < (bv ?? 0) ? -1 : 1;
					return dir === 'DESC' ? -cmp : cmp;
				}
				return 0;
			});
		}
		if (m[5]) rows = rows.slice(0, Number.parseInt(m[5], 10));

		const projection = m[1].trim();
		if (projection === '*') return rows;
		const countMatch = projection.match(/COUNT\(\*\)\s+(?:AS\s+)?(\w+)/i);
		if (countMatch) {
			return [{ [countMatch[1]]: rows.length }];
		}
		const cols = projection.split(',').map((c) => c.trim());
		return rows.map((r) => {
			const out: Row = {};
			for (const c of cols) out[c] = r[c] ?? null;
			return out;
		});
	}

	private getTable(name: string): Table {
		const t = this.tables.get(name);
		if (!t) throw new Error(`No such table: ${name}`);
		return t;
	}
}

function splitStatements(sql: string): string[] {
	return sql
		.split(';')
		.map((s) => s.trim())
		.filter(Boolean);
}

function compilePredicate(where: string, params: Value[]): (row: Row) => boolean {
	const clauses = where.split(/\s+AND\s+/i).map((c) => c.trim());
	let pi = 0;
	const checks: Array<(row: Row) => boolean> = [];
	for (const clause of clauses) {
		const inMatch = clause.match(/^(\w+)\s+IN\s*\(([^)]+)\)$/i);
		if (inMatch) {
			const col = inMatch[1];
			const values = inMatch[2]
				.split(',')
				.map((v) => v.trim().replace(/^'(.*)'$/, '$1'));
			checks.push((r) => values.includes(String(r[col])));
			continue;
		}
		const neq = clause.match(/^(\w+)\s*!=\s*\?$/);
		if (neq) {
			const col = neq[1];
			const val = params[pi++];
			checks.push((r) => r[col] !== val);
			continue;
		}
		const eq = clause.match(/^(\w+)\s*=\s*\?$/);
		if (eq) {
			const col = eq[1];
			const val = params[pi++];
			checks.push((r) => r[col] === val);
			continue;
		}
		// 未対応の句は常に true
		checks.push(() => true);
	}
	return (row) => checks.every((f) => f(row));
}

const dbs = new Map<string, MockDatabase>();

export async function openDatabaseAsync(name: string): Promise<MockDatabase> {
	let db = dbs.get(name);
	if (!db) {
		db = new MockDatabase();
		dbs.set(name, db);
	}
	return db;
}

export type SQLiteDatabase = MockDatabase;

export function resetSqlite(): void {
	dbs.clear();
}

export default { openDatabaseAsync };
