import { describe, it, expect, beforeAll } from 'vitest';
import { buildFixtureDb, dayAt, type FixtureDb } from './fixture.js';
import { openDatabase } from '../src/db.js';
import { dailyRows, modelRows, agentRows, sessionRows, toolRows, totals } from '../src/queries.js';
import { BUILTIN_PRICING } from '../src/pricing.js';

let fx: FixtureDb;
let dbPath: string;

beforeAll(() => {
	fx = buildFixtureDb();
	dbPath = fx.path;
	fx.addSession('sess_a', 'First session', '/home/me/project-alpha');
	fx.addSession('sess_b', 'Second session', '/home/me/project-beta');
	// Day 1: priced model, 2 requests
	for (let i = 0; i < 2; i++) {
		fx.addRequest({
			sessionId: 'sess_a',
			model: 'claude-sonnet-4-5',
			startedAt: dayAt('2026-11-20', 10, i),
			input: 1000,
			output: 500,
			cacheRead: 2000,
			cacheWrite: 100,
			ttftMs: 200 + i * 100,
			durationMs: 1000,
		});
	}
	// Day 1: error request with retries, unpriced model
	fx.addRequest({
		sessionId: 'sess_a',
		model: 'mystery-model',
		status: 'error',
		startedAt: dayAt('2026-11-20', 11),
		input: 500,
		output: 100,
		retries: 3,
		ttftMs: null,
	});
	// Day 2: cancelled request
	fx.addRequest({
		sessionId: 'sess_b',
		model: 'claude-sonnet-4-5',
		status: 'cancelled',
		startedAt: dayAt('2026-11-21', 9),
		input: 800,
		output: 200,
	});
	// subagent requests on day 2
	fx.addRequest({
		sessionId: 'sess_b',
		model: 'claude-sonnet-4-5',
		agent: 'sub-explorer',
		startedAt: dayAt('2026-11-21', 9, 30),
		input: 400,
		output: 300,
	});
	// tools
	fx.addTool({ tool: 'Bash', status: 'error', startedAt: dayAt('2026-11-20', 10), durationMs: 5000, outputBytes: 1000 });
	fx.addTool({ tool: 'Bash', startedAt: dayAt('2026-11-20', 10, 5), durationMs: 1000, outputBytes: 2000 });
	fx.addTool({ tool: 'WebFetch', scope: 'network', startedAt: dayAt('2026-11-21', 9), durationMs: 2000, outputBytes: 500 });
	fx.addTool({ tool: 'rm', destructive: 1, startedAt: dayAt('2026-11-21', 9, 1), durationMs: 10, outputBytes: 10 });
});

describe('dailyRows', () => {
	it('aggregates by local day with cost from priced models', () => {
		const db = openDatabase(dbPath);
		try {
			const rows = dailyRows(db, {}, BUILTIN_PRICING);
			expect(rows).toHaveLength(2);
			expect(rows[0].key).toBe('2026-11-20');
			// sonnet 4.5: in $3/M out $15/M cacheRead $0.3/M cacheWrite $3.75/M
			// 2×(1000 in + 500 out) + 2×2000 cr + 2×100 cw
			// = (2000*3 + 1000*15 + 4000*0.3 + 200*3.75)/1e6 = (6000+15000+1200+750)/1e6 = $0.02295
			expect(rows[0].costUsd).toBeCloseTo(0.02295, 6);
			expect(rows[0].costPartial).toBe(true); // mystery-model unpriced
			expect(rows[0].requests).toBe(3);
			expect(rows[0].inputTokens).toBe(2500);
			expect(rows[0].totalTokens).toBe(2500 + 1100 + 4000 + 200);
			expect(rows[1].key).toBe('2026-11-21');
			expect(rows[1].costPartial).toBe(false);
			expect(rows[1].requests).toBe(2);
		} finally {
			db.close();
		}
	});

	it('respects since/until local-date filters', () => {
		const db = openDatabase(dbPath);
		try {
			const rows = dailyRows(db, { since: '2026-11-21', until: '2026-11-21' }, BUILTIN_PRICING);
			expect(rows).toHaveLength(1);
			expect(rows[0].key).toBe('2026-11-21');
		} finally {
			db.close();
		}
	});
});

describe('modelRows', () => {
	it('groups by provider+model with p50 ttft and reliability stats', () => {
		const db = openDatabase(dbPath);
		try {
			const rows = modelRows(db, {}, BUILTIN_PRICING);
			const sonnet = rows.find((r) => r.model === 'claude-sonnet-4-5');
			expect(sonnet).toBeDefined();
			expect(sonnet!.requests).toBe(4);
			expect(sonnet!.errors).toBe(0);
			expect(sonnet!.cancelled).toBe(1);
			// ttft values: 200, 300 → median 250
			expect(sonnet!.p50TtftMs).toBe(250);
			expect(sonnet!.provider).toBe('test-provider');
			const mystery = rows.find((r) => r.model === 'mystery-model');
			expect(mystery!.errors).toBe(1);
			expect(mystery!.retries).toBe(3);
			expect(mystery!.p50TtftMs).toBeNull();
			expect(mystery!.costUsd).toBeNull();
			// sonnet cost: 4 reqs → 2×0.011475 (day1) + 1×(800*3+200*15)/1e6 + 1×(400*3+300*15)/1e6
			expect(sonnet!.costUsd).toBeCloseTo(0.02295 + 0.0054 + 0.0057, 6);
		} finally {
			db.close();
		}
	});
});

describe('agentRows', () => {
	it('separates main agent from subagents', () => {
		const db = openDatabase(dbPath);
		try {
			const rows = agentRows(db, {}, BUILTIN_PRICING);
			const main = rows.find((r) => r.key === 'main-agent');
			const sub = rows.find((r) => r.key === 'sub-explorer');
			expect(main).toBeDefined();
			expect(main!.requests).toBe(4); // 2 sonnet + 1 mystery + 1 cancelled sonnet
			expect(sub!.requests).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe('sessionRows', () => {
	it('joins session metadata and computes per-session cost', () => {
		const db = openDatabase(dbPath);
		try {
			const rows = sessionRows(db, { top: 10 }, BUILTIN_PRICING);
			expect(rows).toHaveLength(2);
			// newest first: sess_b (2026-11-21) before sess_a (2026-11-20)
			expect(rows[0].sessionId).toBe('sess_b');
			expect(rows[0].label).toBe('Second session');
			expect(rows[0].secondary).toBe('/home/me/project-beta');
			expect(rows[0].costUsd).toBeCloseTo(0.0054 + 0.0057, 6);
			expect(rows[0].costPartial).toBe(false);
			expect(rows[1].sessionId).toBe('sess_a');
			expect(rows[1].costPartial).toBe(true); // includes mystery-model
		} finally {
			db.close();
		}
	});

	it('respects top limit', () => {
		const db = openDatabase(dbPath);
		try {
			const rows = sessionRows(db, { top: 1 }, BUILTIN_PRICING);
			expect(rows).toHaveLength(1);
		} finally {
			db.close();
		}
	});
});

describe('toolRows', () => {
	it('aggregates tool stats including destructive and network flags', () => {
		const db = openDatabase(dbPath);
		try {
			const rows = toolRows(db, {});
			const bash = rows.find((r) => r.tool === 'Bash');
			expect(bash!.calls).toBe(2);
			expect(bash!.errors).toBe(1);
			expect(bash!.avgDurationMs).toBe(3000);
			expect(bash!.avgOutputBytes).toBe(1500);
			const web = rows.find((r) => r.tool === 'WebFetch');
			expect(web!.network).toBe(1);
			const rm = rows.find((r) => r.tool === 'rm');
			expect(rm!.destructive).toBe(1);
		} finally {
			db.close();
		}
	});
});

describe('totals', () => {
	it('sums the whole history', () => {
		const db = openDatabase(dbPath);
		try {
			const t = totals(db, {}, BUILTIN_PRICING);
			expect(t.sessions).toBe(2);
			expect(t.requests).toBe(5);
			expect(t.errors).toBe(1);
			expect(t.cancelled).toBe(1);
			expect(t.retries).toBe(3);
			expect(t.toolCalls).toBe(4);
			expect(t.toolErrors).toBe(1);
			expect(t.destructiveToolCalls).toBe(1);
			expect(t.networkToolCalls).toBe(1);
			expect(t.firstDay).toBe('2026-11-20');
			expect(t.lastDay).toBe('2026-11-21');
		} finally {
			db.close();
		}
	});
});
