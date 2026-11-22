import { DatabaseSync } from 'node:sqlite';
import { existsSync, copyFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { homedir } from 'node:os';
import type { UsageDatabase } from './types.js';

export const DEFAULT_DB_PATH = join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite');

/** Tables zcusage reads. All are pure telemetry — no message content. */
const REQUIRED_TABLES = ['model_usage', 'session', 'tool_usage'] as const;

interface OpenResult {
	db: InstanceType<typeof DatabaseSync>;
	path: string;
	copied: boolean;
}

/**
 * Open the ZCode session database read-only.
 *
 * `readOnly` keeps us safe from racing with a running ZCode instance, but
 * SQLite refuses a truly read-only connection to a WAL database whose -shm
 * it cannot create/write — which can happen with restrictive permissions or
 * on some network filesystems. In that case we fall back to copying the
 * database (plus -wal/-shm sidecars) into a private temp directory and read
 * the copy. Either way the original file is never touched.
 */
export function openDatabase(path: string): UsageDatabase {
	const resolved = resolvePath(path);
	if (!existsSync(resolved)) {
		throw new Error(
			`ZCode database not found at ${resolved}\n` +
				`Pass --db <path> if yours lives elsewhere (it is usually ~/.zcode/cli/db/db.sqlite).`
		);
	}
	let opened: OpenResult;
	try {
		opened = { db: openReadOnly(resolved), path: resolved, copied: false };
		smokeTest(opened.db);
	} catch (err) {
		// WAL/read-only failure or a transient lock — retry against a temp copy.
		const copy = copyToTemp(resolved);
		try {
			opened = { db: openReadOnly(copy), path: copy, copied: true };
			smokeTest(opened.db);
		} catch (copyErr) {
			throw new Error(
				`Cannot open ZCode database at ${resolved}: ${(copyErr as Error).message}`
			);
		}
	}
	const wrapper: UsageDatabase = {
		path: opened.path,
		query(sql: string, params: unknown[] = []): unknown[] {
			// widen the typed statement signature — values come from our own call sites
			const stmt = opened.db.prepare(sql) as unknown as {
				all: (...params: unknown[]) => unknown[];
			};
			return stmt.all(...params);
		},
		close() {
			opened.db.close();
		},
	};
	return wrapper;
}

function openReadOnly(path: string): InstanceType<typeof DatabaseSync> {
	return new DatabaseSync(path, { readOnly: true });
}

function smokeTest(db: InstanceType<typeof DatabaseSync>): void {
	for (const table of REQUIRED_TABLES) {
		const row = db
			.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`)
			.get(table) as { name: string } | undefined;
		if (!row) {
			throw new Error(`missing table ${table}`);
		}
	}
}

function copyToTemp(path: string): string {
	const dir = mkdtempSync(join(tmpdir(), 'zcusage-'));
	for (const suffix of ['', '-wal', '-shm']) {
		const src = path + suffix;
		if (existsSync(src)) copyFileSync(src, join(dir, 'db.sqlite' + suffix));
	}
	return join(dir, 'db.sqlite');
}

function resolvePath(path: string): string {
	if (path.startsWith('~')) {
		return join(homedir(), path.slice(1));
	}
	return path;
}
