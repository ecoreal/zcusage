import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
	BUILTIN_PRICING,
	normalizeModelId,
	lookupPrice,
	computeCost,
	parsePricingFile,
	loadPricing,
} from '../src/pricing.js';

describe('normalizeModelId', () => {
	it('lowercases and trims', () => {
		expect(normalizeModelId('  Claude-Sonnet-4.5 ')).toBe('claude-sonnet-4.5');
	});
});

describe('lookupPrice', () => {
	it('finds exact builtin models', () => {
		expect(lookupPrice('claude-sonnet-4-5', BUILTIN_PRICING)).not.toBeNull();
	});

	it('strips path prefixes (suffix match)', () => {
		expect(lookupPrice('anthropic/claude-sonnet-4-5', BUILTIN_PRICING)).not.toBeNull();
		expect(lookupPrice('account:some-plan/gpt-5.1', BUILTIN_PRICING)).not.toBeNull();
	});

	it('strips -preview/-latest decorations', () => {
		expect(lookupPrice('gemini-3-pro-preview', BUILTIN_PRICING)).not.toBeNull();
		expect(lookupPrice('gpt-5.1-latest', BUILTIN_PRICING)).not.toBeNull();
	});

	it('returns null for unknown models', () => {
		expect(lookupPrice('totally-made-up-model', BUILTIN_PRICING)).toBeNull();
	});
});

describe('computeCost', () => {
	it('prices input/output/cache per Anthropic semantics', () => {
		// sonnet 4.5: in 3/M, out 15/M, cacheRead 0.3/M, cacheWrite 3.75/M
		const cost = computeCost(
			'claude-sonnet-4-5',
			{ inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 500_000, cacheWriteTokens: 10_000 },
			BUILTIN_PRICING
		);
		// 3 + 1.5 + 0.15 + 0.0375 = 4.6875
		expect(cost).toBeCloseTo(4.6875, 6);
	});

	it('falls back to input price for cache when unset', () => {
		const cost = computeCost(
			'kimi-k2',
			{ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000, cacheWriteTokens: 0 },
			BUILTIN_PRICING
		);
		expect(cost).toBeCloseTo(0.55, 6); // 1M × input price
	});

	it('returns null for unknown models', () => {
		expect(
			computeCost('nope', { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, BUILTIN_PRICING)
		).toBeNull();
	});
});

describe('parsePricingFile', () => {
	it('accepts LiteLLM format', () => {
		const dir = mkdtempSync(join(tmpdir(), 'zcusage-price-'));
		const path = join(dir, 'litellm.json');
		writeFileSync(
			path,
			JSON.stringify({
				'test-model-a': {
					input_cost_per_token: 2e-6,
					output_cost_per_token: 8e-6,
					cache_read_input_token_cost: 0.5e-6,
					cache_creation_input_token_cost: 2.5e-6,
				},
			})
		);
		const table = parsePricingFile(path);
		const entry = lookupPrice('test-model-a', table);
		expect(entry).toEqual({ input: 2e-6, output: 8e-6, cacheRead: 0.5e-6, cacheWrite: 2.5e-6 });
	});

	it('auto-scales per-MTok simple format to per-token', () => {
		const dir = mkdtempSync(join(tmpdir(), 'zcusage-price-'));
		const path = join(dir, 'simple.json');
		writeFileSync(
			path,
			JSON.stringify({ 'test-model-b': { input: 0.6, output: 2.2, cacheRead: 0.11 } })
		);
		const table = parsePricingFile(path);
		const entry = lookupPrice('test-model-b', table);
		expect(entry!.input).toBeCloseTo(6e-7, 12);
		expect(entry!.output).toBeCloseTo(2.2e-6, 12);
		expect(entry!.cacheRead).toBeCloseTo(1.1e-7, 12);
	});
});

describe('loadPricing', () => {
	it('file override wins over builtin', () => {
		const dir = mkdtempSync(join(tmpdir(), 'zcusage-price-'));
		const path = join(dir, 'override.json');
		writeFileSync(path, JSON.stringify({ 'claude-sonnet-4-5': { input: 3e-6, output: 15e-6 } }));
		const { table, source } = loadPricing(path);
		expect(source).toBe('file');
		expect(table['claude-sonnet-4-5']!.input).toBe(3e-6);
	});

	it('throws a clear error for missing override file', () => {
		expect(() => loadPricing('/nonexistent/pricing.json')).toThrow();
	});
});
