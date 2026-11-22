import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

/** Column subset matching ZCode's real schema — only what zcusage queries. */
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

export interface FixtureRequest {
	sessionId?: string;
	provider?: string;
	model?: string;
	agent?: string;
	status?: string;
	startedAt: number;
	durationMs?: number;
	ttftMs?: number | null;
	input?: number;
	output?: number;
	reasoning?: number;
	cacheRead?: number;
	cacheWrite?: number;
	retries?: number;
}

export interface FixtureTool {
	sessionId?: string;
	tool: string;
	status?: string;
	destructive?: number;
	readOnly?: number;
	scope?: string;
	startedAt: number;
	durationMs?: number;
	outputBytes?: number;
}

/** Local-time day → epoch ms helpers (dates without a Z suffix parse local). */
export function localDayStart(day: string): number {
	return new Date(`${day}T00:00:00`).getTime();
}

export interface FixtureDb {
	path: string;
	addRequest(req: FixtureRequest): void;
	addTool(tool: FixtureTool): void;
	addSession(id: string, title: string, directory: string): void;
}

export function buildFixtureDb(): FixtureDb {
	const dir = mkdtempSync(join(tmpdir(), 'zcusage-test-'));
	const path = join(dir, 'db.sqlite');
	const db = new DatabaseSync(path);
	db.exec(SCHEMA);
	let nextId = 1;
	return {
		path,
		addRequest(req) {
			db.prepare(
				`INSERT INTO model_usage (id, session_id, provider_id, model_id, agent, status, started_at,
					completed_at, duration_ms, time_to_first_token_ms, input_tokens, output_tokens,
					reasoning_tokens, cache_read_input_tokens, cache_creation_input_tokens, retry_count)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				nextId++,
				req.sessionId ?? 'sess_main',
				req.provider ?? 'test-provider',
				req.model ?? 'test-model',
				req.agent ?? 'main-agent',
				req.status ?? 'completed',
				req.startedAt,
				req.startedAt + (req.durationMs ?? 1000),
				req.durationMs ?? 1000,
				req.ttftMs ?? null,
				req.input ?? 100,
				req.output ?? 50,
				req.reasoning ?? 0,
				req.cacheRead ?? 0,
				req.cacheWrite ?? 0,
				req.retries ?? 0
			);
		},
		addTool(tool) {
			db.prepare(
				`INSERT INTO tool_usage (id, session_id, tool_name, side_effect_scope, read_only,
					destructive, approval_status, status, started_at, completed_at, duration_ms, output_bytes)
				VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
			).run(
				nextId++,
				tool.sessionId ?? 'sess_main',
				tool.tool,
				tool.scope ?? null,
				tool.readOnly ?? 0,
				tool.destructive ?? 0,
				'none',
				tool.status ?? 'completed',
				tool.startedAt,
				tool.startedAt + (tool.durationMs ?? 10),
				tool.durationMs ?? 10,
				tool.outputBytes ?? 100
			);
		},
		addSession(id, title, directory) {
			db.prepare(
				`INSERT INTO session (id, title, slug, directory, time_created, time_updated)
				VALUES (?, ?, ?, ?, ?, ?)`
			).run(id, title, id, directory, localDayStart('2026-11-20'), localDayStart('2026-11-20'));
		},
	};
}

/** Day X in local time — ISO-like short spec used in fixtures. */
export function dayAt(day: string, hour = 12, minute = 0): number {
	return new Date(`${day}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`).getTime();
}
