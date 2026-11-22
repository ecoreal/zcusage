import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { UsageDatabase } from './types.js';

/** Fallback data source: ZCode's per-session JSONL rollouts
 * (`~/.zcode/cli/rollout/model-io-sess_*.jsonl`) for machines without the
 * SQLite store.
 *
 * Each `model_io` record carries request-level usage. We never read the
 * `request.messages` / `response.text` payload — only scalar telemetry.
 * Parsed records are loaded into an in-memory SQLite database using the
 * same schema subset the SQLite backend uses, so the whole query layer
 * works unchanged. Degradations vs SQLite: no session titles/directories
 * (session/project views fall back to ids) and no TTFT. */

/** Schema subset matching src/db.ts expectations (see test/fixture.ts). */
const SCHEMA = `
CREATE TABLE model_usage (
	id INTEGER PRIMARY KEY,
	session_id TEXT,
	provider_id TEXT,
	model_id TEXT,
	agent TEXT,
	status TEXT,
	started_at INTEGER,
	completed_at INTEGER,
	duration_ms INTEGER,
	time_to_first_token_ms INTEGER,
	input_tokens INTEGER,
	output_tokens INTEGER,
	reasoning_tokens INTEGER,
	cache_read_input_tokens INTEGER,
	cache_creation_input_tokens INTEGER,
	retry_count INTEGER,
	cancelled_by_user INTEGER,
	tool_call_count INTEGER
);
CREATE TABLE session (
	id TEXT PRIMARY KEY,
	title TEXT,
	slug TEXT,
	directory TEXT,
	time_created INTEGER,
	time_updated INTEGER
);
CREATE TABLE tool_usage (
	id INTEGER PRIMARY KEY,
	session_id TEXT,
	tool_name TEXT,
	side_effect_scope TEXT,
	read_only INTEGER,
	destructive INTEGER,
	approval_status TEXT,
	status TEXT,
	started_at INTEGER,
	completed_at INTEGER,
	duration_ms INTEGER,
	output_bytes INTEGER
);
`;

interface ModelRef {
	modelId?: unknown;
	providerId?: unknown;
}

interface JsonlRecord {
	type?: unknown;
	sessionId?: unknown;
	attempt?: unknown;
	model?: unknown;
	startedAt?: unknown;
	completedAt?: unknown;
	durationMs?: unknown;
	response?: {
		finishReason?: unknown;
		modelId?: unknown;
		usage?: Record<string, unknown> | null;
		toolCalls?: unknown[];
	} | null;
}

function num(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

function toEpochMs(v: unknown): number | null {
	if (typeof v !== 'string') return null;
	const t = Date.parse(v);
	return Number.isNaN(t) ? null : t;
}

/** Parse one rollout file's text into insert-ready rows (pure, testable).
 * Row ids are assigned by the caller (openJsonlSource) so ids stay unique
 * across multiple files. */
export function extractUsageRecords(text: string): Array<Record<string, unknown>> {
	const rows: Array<Record<string, unknown>> = [];
	for (const line of text.split('\n')) {
		if (!line.trim()) continue;
		let rec: JsonlRecord;
		try {
			rec = JSON.parse(line) as JsonlRecord;
		} catch {
			continue; // tolerate torn/truncated trailing lines
		}
		if (rec.type !== 'model_io') continue;
		const modelRef = (rec.model ?? {}) as ModelRef;
		const resp = rec.response ?? null;
		const usage = resp?.usage ?? null;
		const started = toEpochMs(rec.startedAt);
		const completed = toEpochMs(rec.completedAt);
		rows.push({
			session_id: typeof rec.sessionId === 'string' ? rec.sessionId : 'unknown',
			provider_id:
				typeof modelRef.providerId === 'string' ? modelRef.providerId : 'unknown',
			model_id: typeof modelRef.modelId === 'string' ? modelRef.modelId : 'unknown',
			agent: 'unknown', // jsonl carries no agent attribution
			status: usage ? 'completed' : 'error',
			started_at: started,
			completed_at: completed,
			duration_ms: typeof rec.durationMs === 'number' ? Math.round(rec.durationMs) : null,
			time_to_first_token_ms: null, // not recorded in jsonl
			input_tokens: usage ? num(usage['inputTokens']) : 0,
			output_tokens: usage ? num(usage['outputTokens']) : 0,
			reasoning_tokens: usage ? num(usage['reasoningTokens']) : 0,
			cache_read_input_tokens: usage ? num(usage['cacheReadTokens']) : 0,
			cache_creation_input_tokens: usage ? num(usage['cacheWriteTokens']) : 0,
			retry_count: Math.max(0, num(rec.attempt) - 1),
			cancelled_by_user: 0,
			tool_call_count: resp?.toolCalls?.length ?? null,
		});
	}
	return rows;
}

export interface JsonlOpenResult {
	db: UsageDatabase;
	files: number;
	records: number;
}

/** Build an in-memory database from a rollout directory. */
export function openJsonlSource(rolloutDir: string): JsonlOpenResult {
	const files = readdirSync(rolloutDir).filter((f) => f.startsWith('model-io-sess_') && f.endsWith('.jsonl'));
	if (files.length === 0) {
		throw new Error(`no model-io-sess_*.jsonl files found in ${rolloutDir}`);
	}
	const db = new DatabaseSync(':memory:');
	db.exec(SCHEMA);
	const insert = db.prepare(
		`INSERT INTO model_usage (id, session_id, provider_id, model_id, agent, status, started_at,
			completed_at, duration_ms, time_to_first_token_ms, input_tokens, output_tokens,
			reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens, retry_count,
			cancelled_by_user, tool_call_count)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
	);
	let records = 0;
	let id = 0;
	for (const file of files) {
		const text = readFileSync(join(rolloutDir, file), 'utf8');
		for (const row of extractUsageRecords(text)) {
			const values = [
				++id,
				row['session_id'],
				row['provider_id'],
				row['model_id'],
				row['agent'],
				row['status'],
				row['started_at'],
				row['completed_at'],
				row['duration_ms'],
				row['time_to_first_token_ms'],
				row['input_tokens'],
				row['output_tokens'],
				row['reasoning_tokens'],
				row['cache_read_input_tokens'],
				row['cache_creation_input_tokens'],
				row['retry_count'],
				row['cancelled_by_user'],
				row['tool_call_count'],
			] as (string | number | null)[];
			insert.run(...values);
			records++;
		}
	}
	const wrapper: UsageDatabase = {
		path: rolloutDir,
		query(sql: string, params: unknown[] = []): unknown[] {
			const stmt = db.prepare(sql) as unknown as {
				all: (...params: unknown[]) => unknown[];
			};
			return stmt.all(...params);
		},
		close() {
			db.close();
		},
	};
	return { db: wrapper, files: files.length, records };
}
