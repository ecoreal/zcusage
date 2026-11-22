import { describe, it, expect, beforeAll } from 'vitest';
import { run, parseArgs, UsageError } from '../src/cli.js';
import { buildFixtureDb, dayAt, type FixtureDb } from './fixture.js';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

let fx: FixtureDb;
let dbPath: string;
let pricingPath: string;

beforeAll(() => {
	fx = buildFixtureDb();
	dbPath = fx.path;
	fx.addSession('sess_x', 'CLI session', '/home/me/cli-project');
	fx.addRequest({
		sessionId: 'sess_x',
		model: 'claude-sonnet-4-5',
		startedAt: dayAt('2026-11-22', 14),
		input: 10_000,
		output: 2_000,
		cacheRead: 30_000,
		ttftMs: 150,
	});
	fx.addTool({ tool: 'Bash', startedAt: dayAt('2026-11-22', 14, 1) });
	const dir = mkdtempSync(join(tmpdir(), 'zcusage-cli-'));
	pricingPath = join(dir, 'pricing.json');
	writeFileSync(pricingPath, JSON.stringify({ 'claude-sonnet-4-5': { input: 3, output: 15, cacheRead: 0.3 } }));
});

describe('parseArgs', () => {
	it('defaults to daily command', () => {
		const opts = parseArgs([]);
		expect(opts.command).toBe('daily');
	});
	it('parses flags and values', () => {
		const opts = parseArgs(['model', '--db', '/tmp/x.sqlite', '--since', '2026-11-01', '--top', '5', '--json']);
		expect(opts.command).toBe('model');
		expect(opts.db).toBe('/tmp/x.sqlite');
		expect(opts.since).toBe('2026-11-01');
		expect(opts.top).toBe(5);
		expect(opts.json).toBe(true);
	});
	it('reads ZCODE_DB env var as default', () => {
		const prev = process.env['ZCODE_DB'];
		process.env['ZCODE_DB'] = '/from/env.sqlite';
		try {
			expect(parseArgs([]).db).toBe('/from/env.sqlite');
		} finally {
			if (prev === undefined) delete process.env['ZCODE_DB'];
			else process.env['ZCODE_DB'] = prev;
		}
	});
	it('rejects unknown args and missing values', () => {
		expect(() => parseArgs(['--wat'])).toThrow(UsageError);
		expect(() => parseArgs(['--db'])).toThrow(UsageError);
		expect(() => parseArgs(['--top', 'x'])).toThrow(UsageError);
	});
});

describe('run', () => {
	it('renders help and version', async () => {
		expect(await run(['--help'])).toContain('Usage: zcusage');
		expect(await run(['--version'])).toMatch(/^zcusage \d/);
	});

	it('daily table includes a total row', async () => {
		const out = await run(['--db', dbPath, '--pricing', pricingPath]);
		expect(out).toContain('2026-11-22');
		expect(out).toContain('total');
		expect(out).toContain('$'); // priced via override file
	});

	it('json output parses and carries cost', async () => {
		const out = await run(['daily', '--db', dbPath, '--pricing', pricingPath, '--json']);
		const parsed = JSON.parse(out) as Array<Record<string, unknown>>;
		expect(Array.isArray(parsed)).toBe(true);
		expect(parsed[0]!['key']).toBe('2026-11-22');
		expect(parsed[0]!['costUsd']).toBeCloseTo((10000 * 3 + 2000 * 15 + 30000 * 0.3) / 1e6, 6);
	});

	it('status prints metric/value pairs', async () => {
		const out = await run(['status', '--db', dbPath, '--pricing', pricingPath]);
		expect(out).toContain('model requests');
		expect(out).toContain('tool calls');
	});

	it('model command shows provider/model columns', async () => {
		const out = await run(['model', '--db', dbPath, '--pricing', pricingPath]);
		expect(out).toContain('test-provider');
		expect(out).toContain('claude-sonnet-4-5');
	});

	it('tools command lists tool names', async () => {
		const out = await run(['tools', '--db', dbPath]);
		expect(out).toContain('Bash');
	});

	it('agents command separates agents', async () => {
		const out = await run(['agents', '--db', dbPath]);
		expect(out).toContain('main-agent');
	});

	it('session command shows titles', async () => {
		const out = await run(['session', '--db', dbPath, '--top', '5']);
		expect(out).toContain('CLI session');
	});

	it('errors clearly on missing database', async () => {
		await expect(run(['--db', '/nonexistent/db.sqlite'])).rejects.toThrow(/not found/);
	});

	it('errors on bad date filters', async () => {
		await expect(run(['--db', dbPath, '--since', 'not-a-date'])).rejects.toThrow(/YYYY-MM-DD/);
	});
});
