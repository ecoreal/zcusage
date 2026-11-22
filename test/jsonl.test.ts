import { describe, it, expect, beforeAll } from 'vitest';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { extractUsageRecords, openJsonlSource } from '../src/jsonl.js';
import { openSource, DEFAULT_ROLLOUT_DIR } from '../src/db.js';
import { dailyRows, projectRows, sessionRows } from '../src/queries.js';
import { BUILTIN_PRICING } from '../src/pricing.js';

const ISO = (day: string): string => `${day}T12:00:00.000Z`;

function modelIoRecord(overrides: Record<string, unknown>): string {
	return JSON.stringify({
		type: 'model_io',
		sessionId: 'sess_j1',
		attempt: 1,
		model: { modelId: 'claude-sonnet-4-5', providerId: 'anthropic' },
		startedAt: ISO('2026-11-22'),
		completedAt: ISO('2026-11-22'),
		durationMs: 1500,
		response: {
			finishReason: 'stop',
			usage: { inputTokens: 1000, outputTokens: 500, totalTokens: 1500, cacheReadTokens: 2000, cacheWriteTokens: 0 },
			toolCalls: [],
		},
		...overrides,
	});
}

describe('extractUsageRecords', () => {
	it('maps model_io records to usage rows', () => {
		const text = [modelIoRecord({}), modelIoRecord({ attempt: 3 })].join('\n');
		const rows = extractUsageRecords(text);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toMatchObject({
			session_id: 'sess_j1',
			provider_id: 'anthropic',
			model_id: 'claude-sonnet-4-5',
			status: 'completed',
			input_tokens: 1000,
			output_tokens: 500,
			cache_read_input_tokens: 2000,
			retry_count: 0,
		});
		expect(rows[0]['started_at']).toBe(Date.parse(ISO('2026-11-22')));
		expect(rows[1]['retry_count']).toBe(2); // attempt 3 → 2 retries
	});

	it('marks records without usage as error', () => {
		const rows = extractUsageRecords(modelIoRecord({ response: null }));
		expect(rows[0]['status']).toBe('error');
		expect(rows[0]['input_tokens']).toBe(0);
	});

	it('skips malformed lines and non-model_io records', () => {
		const text = [
			'{broken json',
			JSON.stringify({ type: 'other_event', sessionId: 'x' }),
			modelIoRecord({}),
			'',
		].join('\n');
		expect(extractUsageRecords(text)).toHaveLength(1);
	});

	it('counts toolCalls', () => {
		const rows = extractUsageRecords(
			modelIoRecord({ response: { finishReason: 'tool-calls', usage: { inputTokens: 1, outputTokens: 1 }, toolCalls: [{}, {}] } })
		);
		expect(rows[0]['tool_call_count']).toBe(2);
	});
});

describe('openJsonlSource + query layer', () => {
	let dir: string;
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), 'zcusage-jsonl-'));
		writeFileSync(
			join(dir, 'model-io-sess_j1.jsonl'),
			[
				modelIoRecord({}),
				modelIoRecord({ model: { modelId: 'gpt-5.1', providerId: 'openai' } }),
			].join('\n')
		);
		writeFileSync(join(dir, 'model-io-sess_j2.jsonl'), modelIoRecord({ sessionId: 'sess_j2' }));
	});

	it('builds an in-memory db the query layer accepts', () => {
		const { db, files, records } = openJsonlSource(dir);
		try {
			expect(files).toBe(2);
			expect(records).toBe(3);
			const rows = dailyRows(db, {}, BUILTIN_PRICING);
			expect(rows).toHaveLength(1);
			expect(rows[0].key).toBe('2026-11-22');
			expect(rows[0].requests).toBe(3);
			// sonnet + gpt-5.1 both priced → no partial
			expect(rows[0].costPartial).toBe(false);
			expect(rows[0].costUsd).not.toBeNull();
		} finally {
			db.close();
		}
	});

	it('session rows degrade to ids without session metadata', () => {
		const { db } = openJsonlSource(dir);
		try {
			const rows = sessionRows(db, {}, BUILTIN_PRICING);
			expect(rows).toHaveLength(2);
			for (const r of rows) {
				expect(r.label).toBeUndefined();
				expect(r.secondary).toBeUndefined();
			}
		} finally {
			db.close();
		}
	});

	it('projectRows yield (unknown) for jsonl sources', () => {
		const { db } = openJsonlSource(dir);
		try {
			const rows = projectRows(db, {}, BUILTIN_PRICING);
			expect(rows).toHaveLength(1);
			expect(rows[0].project).toBe('(unknown)');
		} finally {
			db.close();
		}
	});

	it('openSource uses jsonl when rolloutDir is given explicitly', () => {
		const opened = openSource({ rolloutDir: dir });
		try {
			expect(opened.source).toBe('jsonl');
			expect(opened.note).toContain('jsonl fallback');
		} finally {
			opened.usage.close();
		}
	});

	it('openSource errors with guidance when neither source exists', () => {
		// explicit rollout dir pointing at a missing path → guidance error
		expect(() => openSource({ rolloutDir: join(dir, 'missing-dir') })).toThrow(
			/No ZCode data source found/
		);
		// explicit db that is missing → clear sqlite error (explicit = sqlite only)
		expect(() => openSource({ db: join(dir, 'nope.sqlite') })).toThrow(/not found/);
		void DEFAULT_ROLLOUT_DIR; // referenced for completeness
	});
});

describe('projectRows on sqlite source', () => {
	let fx: import('./fixture.js').FixtureDb;
	let dbPath: string;
	beforeAll(async () => {
		const { buildFixtureDb, dayAt } = await import('./fixture.js');
		fx = buildFixtureDb();
		dbPath = fx.path;
		fx.addSession('s1', 'Alpha', '/home/me/alpha');
		fx.addSession('s2', 'Beta', '/home/me/beta');
		fx.addRequest({ sessionId: 's1', model: 'claude-sonnet-4-5', startedAt: dayAt('2026-11-20'), input: 1000, output: 100, cacheRead: 0, cacheWrite: 0 });
		fx.addRequest({ sessionId: 's1', model: 'claude-sonnet-4-5', startedAt: dayAt('2026-11-20'), input: 2000, output: 200, cacheRead: 0, cacheWrite: 0 });
		fx.addRequest({ sessionId: 's2', model: 'gpt-5.1', startedAt: dayAt('2026-11-21'), input: 500, output: 50, cacheRead: 0, cacheWrite: 0 });
	});

	it('rolls up per directory with sessions count and cost', async () => {
		const { openDatabase } = await import('../src/db.js');
		const db = openDatabase(dbPath);
		try {
			const rows = projectRows(db, {}, BUILTIN_PRICING);
			expect(rows).toHaveLength(2);
			const alpha = rows.find((r) => r.project === '/home/me/alpha');
			expect(alpha!.sessions).toBe(1);
			expect(alpha!.requests).toBe(2);
			expect(alpha!.totalTokens).toBe(3300);
			expect(alpha!.costUsd).not.toBeNull();
			const beta = rows.find((r) => r.project === '/home/me/beta');
			expect(beta!.sessions).toBe(1);
			// sorted by total tokens desc
			expect(rows[0].project).toBe('/home/me/alpha');
		} finally {
			db.close();
		}
	});

	it('--project filter narrows other queries', async () => {
		const { openDatabase } = await import('../src/db.js');
		const { totals } = await import('../src/queries.js');
		const db = openDatabase(dbPath);
		try {
			const t = totals(db, { project: 'beta' }, BUILTIN_PRICING);
			expect(t.requests).toBe(1);
			expect(t.sessions).toBe(1);
			const daily = dailyRows(db, { project: 'alpha' }, BUILTIN_PRICING);
			expect(daily).toHaveLength(1);
			expect(daily[0].requests).toBe(2);
		} finally {
			db.close();
		}
	});
});
