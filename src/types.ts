/** Aggregated usage rows returned by the query layer. Cost fields are filled
 * by the pricing layer (may be null when a model has no known price). */

export interface UsageRow {
	key: string; // day / session id / "provider|model" / tool name / agent name
	label?: string; // human label (e.g. session title)
	secondary?: string; // e.g. session directory
	requests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number | null;
	/** true when some underlying models had no known price, so the cost is a lower bound */
	costPartial?: boolean;
}

export interface ModelRow extends UsageRow {
	provider: string;
	model: string;
	errors: number;
	cancelled: number;
	retries: number;
	avgDurationMs: number | null;
	p50TtftMs: number | null;
	avgTtftMs: number | null;
}

export interface SessionRow extends UsageRow {
	sessionId: string;
	durationMs: number | null;
	lastActive: number | null; // epoch ms
}

export interface ToolRow {
	tool: string;
	calls: number;
	errors: number;
	cancelled: number;
	destructive: number;
	network: number;
	readOnly: number;
	avgDurationMs: number | null;
	avgOutputBytes: number | null;
}

export interface Totals {
	firstDay: string | null;
	lastDay: string | null;
	sessions: number;
	requests: number;
	inputTokens: number;
	outputTokens: number;
	reasoningTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
	totalTokens: number;
	costUsd: number | null;
	/** true when some underlying models had no known price, so the cost is a lower bound */
	costPartial?: boolean;
	errors: number;
	cancelled: number;
	retries: number;
	avgTtftMs: number | null;
	toolCalls: number;
	toolErrors: number;
	destructiveToolCalls: number;
	networkToolCalls: number;
}

export interface UsageDatabase {
	query(sql: string, params?: unknown[]): unknown[];
	readonly path: string;
	close(): void;
}
