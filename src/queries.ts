import type { UsageDatabase } from './types.js';
import type { UsageRow, ModelRow, SessionRow, ToolRow, Totals, ProjectRow } from './types.js';
import { computeCost, type PricingTable } from './pricing.js';

export interface QueryFilters {
	/** YYYY-MM-DD (inclusive, local time) */
	since?: string;
	/** YYYY-MM-DD (inclusive, local time) */
	until?: string;
	top?: number;
	/** substring match on session.directory (SQLite source only) */
	project?: string;
}

interface Bound {
	min: number;
	max: number;
}

/** WHERE fragment restricting model_usage/tool_usage rows to sessions whose
 * directory matches the --project substring. Empty string when unset.
 * Appended after the time-bound placeholders; pushes one param. */
function projectClause(project: string | undefined, params: unknown[]): string {
	if (!project) return '';
	params.push(`%${project}%`);
	return ' AND session_id IN (SELECT id FROM session WHERE directory LIKE ?)';
}

function epochBound(filters: QueryFilters): Bound {
	// Local-time day boundaries; epoch ms timestamps in the DB.
	const min = filters.since
		? new Date(`${filters.since}T00:00:00`).getTime()
		: Number.NEGATIVE_INFINITY;
	const max = filters.until
		? new Date(`${filters.until}T23:59:59.999`).getTime()
		: Number.POSITIVE_INFINITY;
	if (Number.isNaN(min) || Number.isNaN(max)) {
		throw new Error('since/until must be YYYY-MM-DD dates');
	}
	return { min, max };
}

const DAY_EXPR = `strftime('%Y-%m-%d', started_at/1000.0, 'unixepoch', 'localtime')`;

function n(v: unknown): number {
	return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Grouped model_usage rows — one row per (groupKey, provider, model). */
interface RawGroup {
	group: string;
	provider: string | null;
	model: string | null;
	requests: number;
	input: number;
	output: number;
	reasoning: number;
	cacheRead: number;
	cacheWrite: number;
	errors: number;
	cancelled: number;
	retries: number;
	durationSum: number | null;
}

function fetchGroups(
	db: UsageDatabase,
	filters: QueryFilters,
	groupExpr: string,
	groupAlias: string
): RawGroup[] {
	const bound = epochBound(filters);
	const params: unknown[] = [bound.min, bound.max];
	const projectSql = projectClause(filters.project, params);
	const rows = db.query(
		`SELECT ${groupExpr} AS ${groupAlias},
				provider_id, model_id,
				COUNT(*) AS requests,
				SUM(input_tokens) AS input,
				SUM(output_tokens) AS output,
				SUM(reasoning_tokens) AS reasoning,
				SUM(cache_read_input_tokens) AS cache_read,
				SUM(cache_creation_input_tokens) AS cache_write,
				SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
				SUM(retry_count) AS retries,
				SUM(duration_ms) AS duration_sum
		FROM model_usage
		WHERE started_at >= ? AND started_at <= ?${projectSql}
		GROUP BY ${groupAlias}, provider_id, model_id
		ORDER BY requests DESC`,
		params
	);
	return rows.map((r) => recordToGroup(r as Record<string, unknown>, groupAlias));
}

function recordToGroup(r: Record<string, unknown>, groupAlias: string): RawGroup {
	return {
		group: String(r[groupAlias] ?? 'unknown'),
		provider: r['provider_id'] === null ? null : String(r['provider_id']),
		model: r['model_id'] === null ? null : String(r['model_id']),
		requests: n(r['requests']),
		input: n(r['input']),
		output: n(r['output']),
		reasoning: n(r['reasoning']),
		cacheRead: n(r['cache_read']),
		cacheWrite: n(r['cache_write']),
		errors: n(r['errors']),
		cancelled: n(r['cancelled']),
		retries: n(r['retries']),
		durationSum: typeof r['duration_sum'] === 'number' ? (r['duration_sum'] as number) : null,
	};
}

function groupToUsageRow(group: RawGroup, table: PricingTable): UsageRow {
	const tokens = {
		inputTokens: group.input,
		outputTokens: group.output,
		cacheReadTokens: group.cacheRead,
		cacheWriteTokens: group.cacheWrite,
	};
	const cost = group.model ? computeCost(group.model, tokens, table) : null;
	return {
		key: group.group,
		requests: group.requests,
		inputTokens: group.input,
		outputTokens: group.output,
		reasoningTokens: group.reasoning,
		cacheReadTokens: group.cacheRead,
		cacheWriteTokens: group.cacheWrite,
		totalTokens: group.input + group.output + group.cacheRead + group.cacheWrite,
		costUsd: cost,
		costPartial: cost === null && (group.input > 0 || group.output > 0),
	};
}

/** Merge per-(day, model) groups into per-day rows. */
export function dailyRows(db: UsageDatabase, filters: QueryFilters, table: PricingTable): UsageRow[] {
	const groups = fetchGroups(db, filters, DAY_EXPR, 'day');
	const byDay = new Map<string, { row: UsageRow; allPriced: boolean }>();
	for (const g of groups) {
		const usage = groupToUsageRow(g, table);
		let entry = byDay.get(g.group);
		if (!entry) {
			entry = {
				row: {
					key: g.group,
					requests: 0,
					inputTokens: 0,
					outputTokens: 0,
					reasoningTokens: 0,
					cacheReadTokens: 0,
					cacheWriteTokens: 0,
					totalTokens: 0,
					costUsd: null,
					costPartial: false,
				},
				allPriced: true,
			};
			byDay.set(g.group, entry);
		}
		const row = entry.row;
		row.requests += usage.requests;
		row.inputTokens += usage.inputTokens;
		row.outputTokens += usage.outputTokens;
		row.reasoningTokens += usage.reasoningTokens;
		row.cacheReadTokens += usage.cacheReadTokens;
		row.cacheWriteTokens += usage.cacheWriteTokens;
		row.totalTokens += usage.totalTokens;
		row.costPartial = row.costPartial || usage.costPartial === true;
		if (usage.costUsd !== null) {
			row.costUsd = (row.costUsd ?? 0) + usage.costUsd;
		} else {
			entry.allPriced = false;
			if (usage.costPartial) row.costPartial = true;
		}
	}
	const out = [...byDay.values()].map((e) => e.row);
	out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
	return out;
}

/** Per (provider, model) breakdown with latency and reliability stats. */
export function modelRows(
	db: UsageDatabase,
	filters: QueryFilters,
	table: PricingTable
): ModelRow[] {
	const groups = fetchGroups(db, filters, `'model'`, '_grp');
	const bound = epochBound(filters);
	const ttftRows = db.query(
		`SELECT provider_id, model_id, time_to_first_token_ms
		FROM model_usage
		WHERE started_at >= ? AND started_at <= ? AND time_to_first_token_ms IS NOT NULL`,
		[bound.min, bound.max]
	);
	const ttftByModel = new Map<string, number[]>();
	for (const r of ttftRows as Record<string, unknown>[]) {
		const key = `${String(r['provider_id'])}|${String(r['model_id'])}`;
		const ttft = r['time_to_first_token_ms'];
		if (typeof ttft === 'number') {
			const list = ttftByModel.get(key);
			if (list) list.push(ttft);
			else ttftByModel.set(key, [ttft]);
		}
	}
	const rows: ModelRow[] = groups.map((g) => {
		const usage = groupToUsageRow(g, table);
		const key = `${String(g.provider)}|${String(g.model)}`;
		const ttft = median(ttftByModel.get(key) ?? []);
		return {
			...usage,
			key: key,
			provider: String(g.provider ?? 'unknown'),
			model: String(g.model ?? 'unknown'),
			errors: g.errors,
			cancelled: g.cancelled,
			retries: g.retries,
			avgDurationMs:
				g.durationSum !== null && g.requests > 0 ? Math.round(g.durationSum / g.requests) : null,
			p50TtftMs: ttft,
			avgTtftMs: null,
		};
	});
	rows.sort((a, b) => b.requests - a.requests || b.totalTokens - a.totalTokens);
	return rows;
}

/** Per-agent breakdown (main agent vs subagents). */
export function agentRows(
	db: UsageDatabase,
	filters: QueryFilters,
	table: PricingTable
): UsageRow[] {
	const groups = fetchGroups(db, filters, `COALESCE(agent, 'unknown')`, 'agent_name');
	const byAgent = new Map<string, UsageRow>();
	for (const g of groups) {
		const usage = groupToUsageRow(g, table);
		const existing = byAgent.get(g.group);
		if (!existing) {
			byAgent.set(g.group, usage);
		} else {
			existing.requests += usage.requests;
			existing.inputTokens += usage.inputTokens;
			existing.outputTokens += usage.outputTokens;
			existing.reasoningTokens += usage.reasoningTokens;
			existing.cacheReadTokens += usage.cacheReadTokens;
			existing.cacheWriteTokens += usage.cacheWriteTokens;
			existing.totalTokens += usage.totalTokens;
			existing.costPartial = existing.costPartial || usage.costPartial === true;
			if (usage.costUsd !== null) {
				existing.costUsd = (existing.costUsd ?? 0) + usage.costUsd;
			}
		}
	}
	const out = [...byAgent.values()];
	out.sort((a, b) => b.requests - a.requests);
	return out;
}

/** Per-session breakdown, newest first. */
export function sessionRows(
	db: UsageDatabase,
	filters: QueryFilters,
	table: PricingTable
): SessionRow[] {
	const bound = epochBound(filters);
	const params: unknown[] = [bound.min, bound.max];
	const projectSql = projectClause(filters.project, params);
	const projectSqlMu = filters.project
		? projectSql.replace('session_id IN', 'mu.session_id IN')
		: '';
	const rows = db.query(
		`SELECT mu.session_id AS session_id,
				COALESCE(s.title, s.slug, s.id) AS title,
				s.directory AS directory,
				MAX(mu.completed_at) AS last_active,
				MIN(mu.started_at) AS first_started,
				MAX(mu.completed_at) AS last_completed,
				COUNT(*) AS requests,
				SUM(mu.input_tokens) AS input,
				SUM(mu.output_tokens) AS output,
				SUM(mu.reasoning_tokens) AS reasoning,
				SUM(mu.cache_read_input_tokens) AS cache_read,
				SUM(mu.cache_creation_input_tokens) AS cache_write,
				SUM(mu.duration_ms) AS duration_sum
		FROM model_usage mu
		LEFT JOIN session s ON s.id = mu.session_id
		WHERE mu.started_at >= ? AND mu.started_at <= ?${projectSqlMu}
		GROUP BY mu.session_id
		ORDER BY last_active DESC`,
		params
	);
	// One pass for per-(session, model) token sums → per-session cost.
	const modelGroups = db.query(
		`SELECT session_id, model_id,
				SUM(input_tokens) AS input, SUM(output_tokens) AS output,
				SUM(cache_read_input_tokens) AS cache_read,
				SUM(cache_creation_input_tokens) AS cache_write
		FROM model_usage
		WHERE started_at >= ? AND started_at <= ?${projectSql}
		GROUP BY session_id, model_id`,
		params
	);
	const costBySession = new Map<string, { cost: number | null; partial: boolean }>();
	for (const g of modelGroups as Record<string, unknown>[]) {
		const sessionId = String(g['session_id']);
		const model = String(g['model_id'] ?? 'unknown');
		const c = computeCost(
			model,
			{
				inputTokens: n(g['input']),
				outputTokens: n(g['output']),
				cacheReadTokens: n(g['cache_read']),
				cacheWriteTokens: n(g['cache_write']),
			},
			table
		);
		const entry = costBySession.get(sessionId) ?? { cost: null, partial: false };
		if (c === null) {
			entry.partial = true;
		} else {
			entry.cost = (entry.cost ?? 0) + c;
		}
		costBySession.set(sessionId, entry);
	}
	const out: SessionRow[] = [];
	for (const r of rows as Record<string, unknown>[]) {
		const sessionId = String(r['session_id'] ?? '');
		const costs = costBySession.get(sessionId);
		const firstStarted = typeof r['first_started'] === 'number' ? r['first_started'] : null;
		const lastCompleted = typeof r['last_completed'] === 'number' ? r['last_completed'] : null;
		out.push({
			key: sessionId,
			sessionId,
			label: r['title'] === null ? undefined : String(r['title']),
			secondary:
				r['directory'] === null || r['directory'] === undefined
					? undefined
					: String(r['directory']),
			requests: n(r['requests']),
			inputTokens: n(r['input']),
			outputTokens: n(r['output']),
			reasoningTokens: n(r['reasoning']),
			cacheReadTokens: n(r['cache_read']),
			cacheWriteTokens: n(r['cache_write']),
			totalTokens:
				n(r['input']) + n(r['output']) + n(r['cache_read']) + n(r['cache_write']),
			costUsd: costs ? costs.cost : null,
			costPartial: costs ? costs.partial : false,
			durationMs:
				firstStarted !== null && lastCompleted !== null ? lastCompleted - firstStarted : null,
			lastActive: typeof r['last_active'] === 'number' ? r['last_active'] : null,
		});
	}
	return filters.top ? out.slice(0, filters.top) : out;
}

/** Per-tool call statistics (from tool_usage telemetry). */
export function toolRows(db: UsageDatabase, filters: QueryFilters): ToolRow[] {
	const bound = epochBound(filters);
	const params: unknown[] = [bound.min, bound.max];
	const projectSql = projectClause(filters.project, params);
	const rows = db.query(
		`SELECT tool_name,
				COUNT(*) AS calls,
				SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
				SUM(CASE WHEN destructive = 1 THEN 1 ELSE 0 END) AS destructive,
				SUM(CASE WHEN side_effect_scope = 'network' THEN 1 ELSE 0 END) AS network,
				SUM(CASE WHEN read_only = 1 THEN 1 ELSE 0 END) AS read_only,
				AVG(duration_ms) AS avg_duration,
				AVG(output_bytes) AS avg_output
		FROM tool_usage
		WHERE started_at >= ? AND started_at <= ?${projectSql}
		GROUP BY tool_name
		ORDER BY calls DESC`,
		params
	);
	return (rows as Record<string, unknown>[]).map((r) => ({
		tool: String(r['tool_name'] ?? 'unknown'),
		calls: n(r['calls']),
		errors: n(r['errors']),
		cancelled: n(r['cancelled']),
		destructive: n(r['destructive']),
		network: n(r['network']),
		readOnly: n(r['read_only']),
		avgDurationMs:
			typeof r['avg_duration'] === 'number' ? Math.round(r['avg_duration']) : null,
		avgOutputBytes:
			typeof r['avg_output'] === 'number' ? Math.round(r['avg_output']) : null,
	}));
}

/** Whole-database summary. */
export function totals(db: UsageDatabase, filters: QueryFilters, table: PricingTable): Totals {
	const bound = epochBound(filters);
	const muParams: unknown[] = [bound.min, bound.max];
	const muProjectSql = projectClause(filters.project, muParams);
	const mu = db.query(
		`SELECT MIN(${DAY_EXPR}) AS first_day,
				MAX(${DAY_EXPR}) AS last_day,
				COUNT(DISTINCT session_id) AS sessions,
				COUNT(*) AS requests,
				SUM(input_tokens) AS input,
				SUM(output_tokens) AS output,
				SUM(reasoning_tokens) AS reasoning,
				SUM(cache_read_input_tokens) AS cache_read,
				SUM(cache_creation_input_tokens) AS cache_write,
				SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN status = 'cancelled' THEN 1 ELSE 0 END) AS cancelled,
				SUM(retry_count) AS retries,
				AVG(time_to_first_token_ms) AS avg_ttft
		FROM model_usage
		WHERE started_at >= ? AND started_at <= ?${muProjectSql}`,
		muParams
	)[0] as Record<string, unknown>;
	const tuParams: unknown[] = [bound.min, bound.max];
	const tuProjectSql = projectClause(filters.project, tuParams);
	const tu = db.query(
		`SELECT COUNT(*) AS calls,
				SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) AS errors,
				SUM(CASE WHEN destructive = 1 THEN 1 ELSE 0 END) AS destructive,
				SUM(CASE WHEN side_effect_scope = 'network' THEN 1 ELSE 0 END) AS network
		FROM tool_usage
		WHERE started_at >= ? AND started_at <= ?${tuProjectSql}`,
		tuParams
	)[0] as Record<string, unknown>;
	const groups = fetchGroups(db, filters, `'model'`, '_grp');
	let cost: number | null = 0;
	let partial = false;
	let pricedGroups = 0;
	for (const g of groups) {
		const c = computeCost(
			String(g.model ?? 'unknown'),
			{
				inputTokens: g.input,
				outputTokens: g.output,
				cacheReadTokens: g.cacheRead,
				cacheWriteTokens: g.cacheWrite,
			},
			table
		);
		if (c === null) partial = true;
		else {
			pricedGroups++;
			if (cost !== null) cost += c;
		}
	}
	if (n(mu['requests']) === 0 || pricedGroups === 0) cost = null;
	return {
		firstDay: mu['first_day'] === null ? null : String(mu['first_day']),
		lastDay: mu['last_day'] === null ? null : String(mu['last_day']),
		sessions: n(mu['sessions']),
		requests: n(mu['requests']),
		inputTokens: n(mu['input']),
		outputTokens: n(mu['output']),
		reasoningTokens: n(mu['reasoning']),
		cacheReadTokens: n(mu['cache_read']),
		cacheWriteTokens: n(mu['cache_write']),
		totalTokens:
			n(mu['input']) + n(mu['output']) + n(mu['cache_read']) + n(mu['cache_write']),
		costUsd: cost,
		costPartial: partial,
		errors: n(mu['errors']),
		cancelled: n(mu['cancelled']),
		retries: n(mu['retries']),
		avgTtftMs:
			typeof mu['avg_ttft'] === 'number' ? Math.round(mu['avg_ttft'] as number) : null,
		toolCalls: n(tu['calls']),
		toolErrors: n(tu['errors']),
		destructiveToolCalls: n(tu['destructive']),
		networkToolCalls: n(tu['network']),
	};
}

/** Per-project (session directory) rollups, biggest spenders first. */
export function projectRows(
	db: UsageDatabase,
	filters: QueryFilters,
	table: PricingTable
): ProjectRow[] {
	const bound = epochBound(filters);
	const params: unknown[] = [bound.min, bound.max];
	const projectSql = projectClause(filters.project, params);
	const rows = db.query(
		`SELECT COALESCE(NULLIF(s.directory, ''), '(unknown)') AS project,
				provider_id, model_id,
				COUNT(*) AS requests,
				SUM(mu.input_tokens) AS input,
				SUM(mu.output_tokens) AS output,
				SUM(mu.reasoning_tokens) AS reasoning,
				SUM(mu.cache_read_input_tokens) AS cache_read,
				SUM(mu.cache_creation_input_tokens) AS cache_write,
				SUM(mu.duration_ms) AS duration_sum
		FROM model_usage mu
		LEFT JOIN session s ON s.id = mu.session_id
		WHERE mu.started_at >= ? AND mu.started_at <= ?${projectSql.replace('session_id IN', 'mu.session_id IN')}
		GROUP BY project, provider_id, model_id
		ORDER BY requests DESC`,
		params
	);
	const byProject = new Map<string, ProjectRow>();
	for (const r of rows as Record<string, unknown>[]) {
		const group: RawGroup = {
			group: String(r['project']),
			provider: r['provider_id'] === null ? null : String(r['provider_id']),
			model: r['model_id'] === null ? null : String(r['model_id']),
			requests: n(r['requests']),
			input: n(r['input']),
			output: n(r['output']),
			reasoning: n(r['reasoning']),
			cacheRead: n(r['cache_read']),
			cacheWrite: n(r['cache_write']),
			errors: 0,
			cancelled: 0,
			retries: 0,
			durationSum: typeof r['duration_sum'] === 'number' ? (r['duration_sum'] as number) : null,
		};
		const usage = groupToUsageRow(group, table);
		let row = byProject.get(group.group);
		if (!row) {
			row = {
				key: group.group,
				project: group.group,
				requests: 0,
				inputTokens: 0,
				outputTokens: 0,
				reasoningTokens: 0,
				cacheReadTokens: 0,
				cacheWriteTokens: 0,
				totalTokens: 0,
				costUsd: null,
				costPartial: false,
				sessions: 0,
				lastActive: null,
			};
			byProject.set(group.group, row);
		}
		row.requests += usage.requests;
		row.inputTokens += usage.inputTokens;
		row.outputTokens += usage.outputTokens;
		row.reasoningTokens += usage.reasoningTokens;
		row.cacheReadTokens += usage.cacheReadTokens;
		row.cacheWriteTokens += usage.cacheWriteTokens;
		row.totalTokens += usage.totalTokens;
		row.costPartial = row.costPartial || usage.costPartial === true;
		if (usage.costUsd !== null) {
			row.costUsd = (row.costUsd ?? 0) + usage.costUsd;
		}
	}
	// sessions + last activity per project
	const aggParams: unknown[] = [bound.min, bound.max];
	const aggSql = projectClause(filters.project, aggParams);
	const aggs = db.query(
		`SELECT COALESCE(NULLIF(s.directory, ''), '(unknown)') AS project,
				COUNT(DISTINCT mu.session_id) AS sessions,
				MAX(mu.completed_at) AS last_active
		FROM model_usage mu
		LEFT JOIN session s ON s.id = mu.session_id
		WHERE mu.started_at >= ? AND mu.started_at <= ?${aggSql.replace('session_id IN', 'mu.session_id IN')}
		GROUP BY project`,
		aggParams
	);
	for (const a of aggs as Record<string, unknown>[]) {
		const row = byProject.get(String(a['project']));
		if (row) {
			row.sessions = n(a['sessions']);
			row.lastActive = typeof a['last_active'] === 'number' ? a['last_active'] : null;
		}
	}
	const out = [...byProject.values()];
	out.sort((a, b) => b.totalTokens - a.totalTokens || b.requests - a.requests);
	return filters.top ? out.slice(0, filters.top) : out;
}

function median(values: number[]): number | null {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b);
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 1
		? sorted[mid]
		: Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}
