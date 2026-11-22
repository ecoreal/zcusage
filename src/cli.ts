import { openDatabase, DEFAULT_DB_PATH } from './db.js';
import { loadPricing, updatePricingCache, pricingCachePath } from './pricing.js';
import {
	dailyRows,
	modelRows,
	agentRows,
	sessionRows,
	toolRows,
	totals,
	type QueryFilters,
} from './queries.js';
import { renderTable, fmtInt, fmtTokens, fmtCost, fmtDuration, fmtTimestamp, truncate } from './format.js';
import type { UsageRow, ToolRow, Totals } from './types.js';

const VERSION = '0.1.0';

const USAGE = `zcusage — usage, cost & performance analytics for ZCode agents

Usage: zcusage [command] [options]

Commands:
  daily            Daily token & cost totals (default)
  session          Per-session breakdown, newest first
  model            Per-model breakdown with latency & reliability
  agents           Main agent vs subagent usage
  tools            Tool call statistics (incl. destructive / network calls)
  status           Whole-history summary
  pricing          Show pricing source; --update fetches LiteLLM's table

Options:
  --db <path>      Path to ZCode's SQLite DB (default: ~/.zcode/cli/db/db.sqlite)
  --since <date>   Start date, YYYY-MM-DD (local time, inclusive)
  --until <date>   End date, YYYY-MM-DD (inclusive)
  --top <n>        Show only the first n rows (session/model)
  --json           Machine-readable JSON output
  --no-cost        Skip cost estimation
  --pricing <file> Extra pricing table (LiteLLM JSON or {model:{input,output}})
  -h, --help       Show this help
  -V, --version    Show version

Data is read-only, local-only telemetry: token counts, latencies, tool call
metadata. Message content is never read.

Report bugs: https://github.com/ecoreal/zcusage/issues`;

export class UsageError extends Error {}

interface CliOptions {
	command: string;
	db: string;
	since?: string;
	until?: string;
	top?: number;
	json: boolean;
	noCost: boolean;
	pricing?: string;
	updatePricing: boolean;
	help: boolean;
	version: boolean;
}

export function parseArgs(argv: string[]): CliOptions {
	const opts: CliOptions = {
		command: 'daily',
		db: process.env['ZCODE_DB'] ?? DEFAULT_DB_PATH,
		json: false,
		noCost: false,
		updatePricing: false,
		help: false,
		version: false,
	};
	const args = [...argv];
	while (args.length > 0) {
		const a = args.shift() as string;
		switch (a) {
			case 'daily':
			case 'session':
			case 'model':
			case 'agents':
			case 'tools':
			case 'status':
			case 'pricing':
				opts.command = a;
				break;
			case '--db':
				opts.db = takeValue(args, a);
				break;
			case '--since':
				opts.since = takeValue(args, a);
				break;
			case '--until':
				opts.until = takeValue(args, a);
				break;
			case '--top':
				opts.top = Number(takeValue(args, a));
				if (!Number.isInteger(opts.top) || opts.top <= 0) {
					throw new UsageError('--top expects a positive integer');
				}
				break;
			case '--json':
				opts.json = true;
				break;
			case '--no-cost':
				opts.noCost = true;
				break;
			case '--pricing':
				opts.pricing = takeValue(args, a);
				break;
			case '--update':
				opts.updatePricing = true;
				break;
			case '-h':
			case '--help':
				opts.help = true;
				break;
			case '-V':
			case '--version':
				opts.version = true;
				break;
			default:
				throw new UsageError(`unknown argument: ${a} (see --help)`);
		}
	}
	return opts;
}

function takeValue(args: string[], flag: string): string {
	const v = args.shift();
	if (v === undefined || v.startsWith('--')) {
		throw new UsageError(`${flag} expects a value`);
	}
	return v;
}

function filtersOf(opts: CliOptions): QueryFilters {
	return { since: opts.since, until: opts.until, top: opts.top };
}

export async function run(argv: string[]): Promise<string> {
	const opts = parseArgs(argv);
	if (opts.help) return USAGE;
	if (opts.version) return `zcusage ${VERSION}`;

	if (opts.command === 'pricing') {
		if (opts.updatePricing) {
			const path = await updatePricingCache();
			return `pricing table written to ${path}`;
		}
		const { source } = loadPricing(opts.pricing);
		return [
			`pricing source: ${source}`,
			`cache path:     ${pricingCachePath()}`,
			`update with:    zcusage pricing --update`,
		].join('\n');
	}

	const { table, source } = loadPricing(opts.pricing);
	const effective = opts.noCost ? {} : table; // empty table → all costs unknown
	const db = openDatabase(opts.db);
	try {
		const filters = filtersOf(opts);
		switch (opts.command) {
			case 'daily': {
				const rows = dailyRows(db, filters, effective);
				return finalize(opts, rows, () => renderDaily(rows), source);
			}
			case 'session': {
				const rows = sessionRows(db, filters, effective);
				return finalize(
					opts,
					rows,
					() =>
						renderTable(
							['last active', 'session', 'project', 'reqs', 'total', 'cost'],
							rows.map((r) => [
								{ text: fmtTimestamp(r.lastActive) },
								{ text: truncate(r.label ?? r.sessionId, 34) },
								{ text: truncate(basename(r.secondary ?? '-'), 22) },
								{ text: fmtInt(r.requests), align: 'right' },
								{ text: fmtTokens(r.totalTokens), align: 'right' },
								{
									text: r.costUsd === null ? '-' : fmtCost(r.costUsd) + (r.costPartial ? '*' : ''),
									align: 'right',
								},
							])
						),
					source
				);
			}
			case 'model': {
				const rows = modelRows(db, filters, effective);
				return finalize(
					opts,
					rows,
					() =>
						renderTable(
							['provider', 'model', 'reqs', 'input', 'output', 'cache r', 'total', 'cost', 'p50 ttft', 'avg dur', 'err/cxl'],
							rows.map((r) => [
								{ text: truncate(r.provider, 18) },
								{ text: truncate(r.model, 28) },
								{ text: fmtInt(r.requests), align: 'right' },
								{ text: fmtTokens(r.inputTokens), align: 'right' },
								{ text: fmtTokens(r.outputTokens), align: 'right' },
								{ text: fmtTokens(r.cacheReadTokens), align: 'right' },
								{ text: fmtTokens(r.totalTokens), align: 'right' },
								{
									text: r.costUsd === null ? '-' : fmtCost(r.costUsd) + (r.costPartial ? '*' : ''),
									align: 'right',
								},
								{ text: r.p50TtftMs === null ? '-' : fmtDuration(r.p50TtftMs), align: 'right' },
								{ text: r.avgDurationMs === null ? '-' : fmtDuration(r.avgDurationMs), align: 'right' },
								{ text: `${r.errors}/${r.cancelled}`, align: 'right' },
							])
						),
					source
				);
			}
			case 'agents': {
				const rows = agentRows(db, filters, effective);
				return finalize(
					opts,
					rows,
					() =>
						renderTable(
							['agent', 'reqs', 'input', 'output', 'total', 'cost'],
							rows.map((r) => [
								{ text: r.key },
								{ text: fmtInt(r.requests), align: 'right' },
								{ text: fmtTokens(r.inputTokens), align: 'right' },
								{ text: fmtTokens(r.outputTokens), align: 'right' },
								{ text: fmtTokens(r.totalTokens), align: 'right' },
								{ text: r.costUsd === null ? '-' : fmtCost(r.costUsd), align: 'right' },
							])
						),
					source
				);
			}
			case 'tools': {
				const rows = toolRows(db, filters);
				return finalize(
					opts,
					rows,
					() =>
						renderTable(
							['tool', 'calls', 'errors', 'destructive', 'network', 'avg dur', 'avg out'],
							rows.map((r: ToolRow) => [
								{ text: truncate(r.tool, 34) },
								{ text: fmtInt(r.calls), align: 'right' },
								{ text: fmtInt(r.errors), align: 'right' },
								{ text: fmtInt(r.destructive), align: 'right' },
								{ text: fmtInt(r.network), align: 'right' },
								{ text: r.avgDurationMs === null ? '-' : fmtDuration(r.avgDurationMs), align: 'right' },
								{ text: r.avgOutputBytes === null ? '-' : fmtTokens(r.avgOutputBytes), align: 'right' },
							])
						),
					source
				);
			}
			case 'status': {
				const t = totals(db, filters, effective);
				return finalize(opts, [t], () => renderStatus(t), source);
			}
			default:
				throw new UsageError(`unknown command: ${opts.command}`);
		}
	} finally {
		db.close();
	}
}

/** JSON passthrough in --json mode; rendered table + pricing footer otherwise. */
function finalize(
	opts: CliOptions,
	payload: Array<UsageRow | ToolRow | Totals> | UsageRow[],
	render: () => string,
	source: string
): string {
	if (opts.json) return JSON.stringify(payload, null, 2);
	let out = render();
	if (opts.noCost) {
		out += '\n\ncost estimation skipped (--no-cost).';
	} else {
		const partial = payload.some(
			(r) => typeof r === 'object' && r !== null && (r as UsageRow).costPartial === true
		);
		if (partial) {
			out += `\n\n* cost is a lower bound — some models have no known price.\n  run \`zcusage pricing --update\` or pass --pricing <file>. (source: ${source})`;
		} else {
			out += `\n\ncost estimates from ${source} pricing table (USD).`;
		}
	}
	return out;
}

function renderDaily(rows: UsageRow[]): string {
	const body = rows.map((r) => [
		{ text: r.key },
		{ text: fmtInt(r.requests), align: 'right' as const },
		{ text: fmtTokens(r.inputTokens), align: 'right' as const },
		{ text: fmtTokens(r.outputTokens), align: 'right' as const },
		{ text: fmtTokens(r.cacheReadTokens), align: 'right' as const },
		{ text: fmtTokens(r.cacheWriteTokens), align: 'right' as const },
		{ text: fmtTokens(r.totalTokens), align: 'right' as const },
		{ text: r.costUsd === null ? '-' : fmtCost(r.costUsd), align: 'right' as const },
	]);
	const total = sumRows(rows);
	body.push([
		{ text: 'total' },
		{ text: fmtInt(total.requests), align: 'right' },
		{ text: fmtTokens(total.inputTokens), align: 'right' },
		{ text: fmtTokens(total.outputTokens), align: 'right' },
		{ text: fmtTokens(total.cacheReadTokens), align: 'right' },
		{ text: fmtTokens(total.cacheWriteTokens), align: 'right' },
		{ text: fmtTokens(total.totalTokens), align: 'right' },
		{ text: total.costUsd === null ? '-' : fmtCost(total.costUsd), align: 'right' },
	]);
	return renderTable(
		['date', 'reqs', 'input', 'output', 'cache r', 'cache w', 'total', 'cost'],
		body
	);
}

function sumRows(rows: UsageRow[]): UsageRow {
	const anyUnpriced = rows.some((r) => r.costUsd === null);
	return {
		key: 'total',
		requests: rows.reduce((a, r) => a + r.requests, 0),
		inputTokens: rows.reduce((a, r) => a + r.inputTokens, 0),
		outputTokens: rows.reduce((a, r) => a + r.outputTokens, 0),
		reasoningTokens: rows.reduce((a, r) => a + r.reasoningTokens, 0),
		cacheReadTokens: rows.reduce((a, r) => a + r.cacheReadTokens, 0),
		cacheWriteTokens: rows.reduce((a, r) => a + r.cacheWriteTokens, 0),
		totalTokens: rows.reduce((a, r) => a + r.totalTokens, 0),
		costUsd: anyUnpriced ? null : rows.reduce((a, r) => a + (r.costUsd ?? 0), 0),
	};
}

function renderStatus(t: Totals): string {
	const cost =
		t.costUsd === null
			? 'unknown'
			: fmtCost(t.costUsd) + (t.costPartial ? ' (lower bound)' : '');
	const lines: Array<[string, string]> = [
		['period', t.firstDay ? `${t.firstDay} → ${t.lastDay}` : '-'],
		['sessions', fmtInt(t.sessions)],
		['model requests', fmtInt(t.requests)],
		['total tokens', fmtTokens(t.totalTokens)],
		['  input', fmtTokens(t.inputTokens)],
		['  output', fmtTokens(t.outputTokens)],
		['  cache read', fmtTokens(t.cacheReadTokens)],
		['  cache write', fmtTokens(t.cacheWriteTokens)],
		['estimated cost', cost],
		['errors / cancelled', `${t.errors} / ${t.cancelled}`],
		['retries', fmtInt(t.retries)],
		['avg time to first token', t.avgTtftMs === null ? '-' : fmtDuration(t.avgTtftMs)],
		['tool calls', fmtInt(t.toolCalls)],
		['  tool errors', fmtInt(t.toolErrors)],
		['  destructive calls', fmtInt(t.destructiveToolCalls)],
		['  network calls', fmtInt(t.networkToolCalls)],
	];
	return renderTable(
		['metric', 'value'],
		lines.map((l) => [{ text: l[0] }, { text: l[1] }])
	);
}

function basename(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx >= 0 ? path.slice(idx + 1) : path;
}
