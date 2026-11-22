import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';

/** Model pricing + cost estimation.
 *
 * Prices are USD per token. The builtin table is best-effort for popular
 * models; a fuller table can be fetched from LiteLLM's pricing JSON
 * (`zcusage pricing --update`) or supplied by hand (`--pricing <file>`).
 * Unknown models simply report no cost — we never guess.
 *
 * Token semantics follow the Anthropic convention ZCode normalizes to:
 * `input_tokens` excludes cache traffic, `cache_read_input_tokens` /
 * `cache_creation_input_tokens` are billed separately (≈0.1× / ≈1.25× of
 * the input rate). Reasoning tokens are treated as already included in
 * `output_tokens`.
 */

export interface PriceEntry {
	/** USD per token */
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

export type PricingTable = Record<string, PriceEntry>;

const M = 1e-6; // helper: $X per MTok → per token

/** Hand-curated builtin prices (USD per MTok, converted at load time).
 * Review dates noted where prices move often. */
const BUILTIN_PER_MTOK: Record<string, PriceEntry> = {
	// Anthropic (2026-11)
	'claude-opus-4-5': { input: 5 * M, output: 25 * M, cacheRead: 0.5 * M, cacheWrite: 6.25 * M },
	'claude-sonnet-4-5': { input: 3 * M, output: 15 * M, cacheRead: 0.3 * M, cacheWrite: 3.75 * M },
	'claude-haiku-4-5': { input: 1 * M, output: 5 * M, cacheRead: 0.1 * M, cacheWrite: 1.25 * M },
	'claude-opus-4-1': { input: 15 * M, output: 75 * M, cacheRead: 1.5 * M, cacheWrite: 18.75 * M },
	'claude-sonnet-4-0': { input: 3 * M, output: 15 * M, cacheRead: 0.3 * M, cacheWrite: 3.75 * M },
	'claude-3-5-haiku': { input: 0.8 * M, output: 4 * M, cacheRead: 0.08 * M, cacheWrite: 1 * M },
	// OpenAI
	'gpt-5.1': { input: 1.25 * M, output: 10 * M, cacheRead: 0.125 * M },
	'gpt-5.1-codex': { input: 1.25 * M, output: 10 * M, cacheRead: 0.125 * M },
	'gpt-5.1-codex-max': { input: 1.25 * M, output: 10 * M, cacheRead: 0.125 * M },
	'gpt-5': { input: 1.25 * M, output: 10 * M, cacheRead: 0.125 * M },
	'gpt-5-codex': { input: 1.25 * M, output: 10 * M, cacheRead: 0.125 * M },
	'gpt-5-mini': { input: 0.25 * M, output: 2 * M, cacheRead: 0.025 * M },
	'gpt-4.1': { input: 2 * M, output: 8 * M, cacheRead: 0.5 * M },
	'o4-mini': { input: 1.1 * M, output: 4.4 * M, cacheRead: 0.275 * M },
	// Google
	'gemini-3-pro-preview': { input: 2 * M, output: 12 * M, cacheRead: 0.2 * M },
	'gemini-2.5-pro': { input: 1.25 * M, output: 10 * M, cacheRead: 0.125 * M },
	'gemini-2.5-flash': { input: 0.3 * M, output: 2.5 * M, cacheRead: 0.03 * M },
	// Z.ai / Zhipu
	'glm-4.6': { input: 0.6 * M, output: 2.2 * M, cacheRead: 0.11 * M },
	'glm-4.5': { input: 0.6 * M, output: 2.2 * M, cacheRead: 0.11 * M },
	'glm-4.5-air': { input: 0.2 * M, output: 0.8 * M, cacheRead: 0.03 * M },
	// Moonshot
	'kimi-k2': { input: 0.55 * M, output: 2.5 * M },
	'kimi-k2-thinking': { input: 0.55 * M, output: 2.5 * M },
	// DeepSeek
	'deepseek-chat': { input: 0.28 * M, output: 0.42 * M, cacheRead: 0.028 * M },
	'deepseek-reasoner': { input: 0.28 * M, output: 0.42 * M, cacheRead: 0.028 * M },
};

export const BUILTIN_PRICING: PricingTable = BUILTIN_PER_MTOK;

/** Cached LiteLLM table fetched via `zcusage pricing --update`. */
export function pricingCachePath(): string {
	const base = process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache');
	return join(base, 'zcusage', 'pricing.json');
}

/** Load the effective pricing table: builtin, overridden by cache, then by
 * an explicit file (LiteLLM JSON or simple {model: {input, output}}). */
export function loadPricing(extraFile?: string): { table: PricingTable; source: string } {
	let table: PricingTable = { ...BUILTIN_PRICING };
	let source = 'builtin';
	const cache = pricingCachePath();
	if (existsSync(cache)) {
		try {
			const parsed = parsePricingFile(cache);
			table = { ...table, ...parsed };
			source = 'cache';
		} catch {
			// corrupt cache — ignore, fall back to builtin
		}
	}
	if (extraFile) {
		const parsed = parsePricingFile(resolveTilde(extraFile));
		table = { ...table, ...parsed };
		source = 'file';
	}
	return { table, source };
}

/** Accepts LiteLLM's model_prices_and_context_window.json keys or a simple
 * {model: {input, output}} map (values may be per-token or per-MTok —
 * per-MTok is detected by magnitude ≥ 1e-4). */
export function parsePricingFile(path: string): PricingTable {
	const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, Record<string, unknown>>;
	const table: PricingTable = {};
	for (const [model, spec] of Object.entries(raw)) {
		if (typeof spec !== 'object' || spec === null) continue;
		const entry = toEntry(spec);
		if (entry) table[normalizeModelId(model)] = entry;
	}
	return table;
}

function toEntry(spec: Record<string, unknown>): PriceEntry | null {
	const num = (v: unknown): number | undefined =>
		typeof v === 'number' && Number.isFinite(v) ? v : undefined;
	// LiteLLM format
	const lit = {
		input: num(spec['input_cost_per_token']),
		output: num(spec['output_cost_per_token']),
		cacheRead: num(spec['cache_read_input_token_cost']),
		cacheWrite: num(spec['cache_creation_input_token_cost']),
	};
	if (lit.input !== undefined && lit.output !== undefined) {
		return {
			input: lit.input,
			output: lit.output,
			cacheRead: lit.cacheRead,
			cacheWrite: lit.cacheWrite,
		};
	}
	// simple format
	const simple = {
		input: num(spec['input']),
		output: num(spec['output']),
		cacheRead: num(spec['cacheRead'] ?? spec['cache_read']),
		cacheWrite: num(spec['cacheWrite'] ?? spec['cache_write']),
	};
	if (simple.input !== undefined && simple.output !== undefined) {
		const scale = (v: number | undefined): number | undefined =>
			v === undefined ? undefined : v >= 1e-4 ? v * M : v;
		return {
			input: scale(simple.input)!,
			output: scale(simple.output)!,
			cacheRead: scale(simple.cacheRead),
			cacheWrite: scale(simple.cacheWrite),
		};
	}
	return null;
}

/** Lowercase, trim, collapse whitespace. */
export function normalizeModelId(model: string): string {
	return model.trim().toLowerCase().replace(/\s+/g, '-');
}

/** Look up a price for a model id. Tries the exact normalized id, then each
 * path suffix (`openai/gpt-5.1` → `gpt-5.1`), also with common decorations
 * (`-preview`, `-latest`, date suffixes) stripped. */
export function lookupPrice(model: string, table: PricingTable): PriceEntry | null {
	const id = normalizeModelId(model);
	const candidates: string[] = [id];
	const parts = id.split('/');
	for (let i = 1; i < parts.length; i++) candidates.push(parts.slice(i).join('/'));
	for (const c of [...candidates]) {
		const stripped = c
			.replace(/-preview$/, '')
			.replace(/-latest$/, '')
			.replace(/-\d{6,8}$/g, '');
		if (stripped !== c) candidates.push(stripped);
	}
	for (const c of candidates) {
		const entry = table[c];
		if (entry) return entry;
	}
	return null;
}

export interface CostTokens {
	inputTokens: number;
	outputTokens: number;
	cacheReadTokens: number;
	cacheWriteTokens: number;
}

/** Estimated USD cost for one request's token counts; null if the model has
 * no known price. */
export function computeCost(model: string, tokens: CostTokens, table: PricingTable): number | null {
	const price = lookupPrice(model, table);
	if (!price) return null;
	let cost =
		tokens.inputTokens * price.input +
		tokens.outputTokens * price.output;
	if (price.cacheRead !== undefined) {
		cost += tokens.cacheReadTokens * price.cacheRead;
	} else {
		cost += tokens.cacheReadTokens * price.input; // conservative
	}
	if (price.cacheWrite !== undefined) {
		cost += tokens.cacheWriteTokens * price.cacheWrite;
	} else {
		cost += tokens.cacheWriteTokens * price.input; // conservative
	}
	return cost;
}

export const LITELLM_PRICING_URL =
	'https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json';

/** Download LiteLLM's pricing JSON into the cache file. Returns the path. */
export async function updatePricingCache(url = LITELLM_PRICING_URL): Promise<string> {
	const res = await fetch(url);
	if (!res.ok) {
		throw new Error(`fetch failed: ${res.status} ${res.statusText} from ${url}`);
	}
	const text = await res.text();
	const parsed = JSON.parse(text) as unknown;
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('unexpected pricing payload: not a JSON object');
	}
	const path = pricingCachePath();
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, text);
	return path;
}

function resolveTilde(path: string): string {
	if (path.startsWith('~')) return join(homedir(), path.slice(1));
	return path;
}
