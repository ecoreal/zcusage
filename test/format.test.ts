import { describe, it, expect } from 'vitest';
import { renderTable, fmtInt, fmtTokens, fmtCost, fmtDuration, truncate } from '../src/format.js';

describe('renderTable', () => {
	it('pads columns and right-aligns numeric-looking headers', () => {
		const out = renderTable(
			['date', 'reqs', 'cost'],
			[
				[{ text: '2026-11-20' }, { text: '12', align: 'right' }, { text: '$1.50', align: 'right' }],
				[{ text: '2026-11-21' }, { text: '3', align: 'right' }, { text: '$0.25', align: 'right' }],
			]
		);
		const lines = out.split('\n');
		expect(lines).toHaveLength(3);
		// header right-aligns numeric columns: both flush to the right edge
		expect(lines[0].trimEnd().endsWith('cost')).toBe(true);
		expect(lines[0].startsWith('date')).toBe(true);
		// rows align right under reqs
		expect(lines[1]).toContain('  12');
		expect(lines[2]).toContain('   3');
		// all rows same length
		expect(lines[1].length).toBe(lines[2].length);
	});
});

describe('number formatting', () => {
	it('fmtInt groups thousands', () => {
		expect(fmtInt(1234567)).toBe('1,234,567');
	});
	it('fmtTokens scales large values', () => {
		expect(fmtTokens(590_120_000)).toBe('590.12M');
		expect(fmtTokens(48_060_000)).toBe('48.06M');
		expect(fmtTokens(9500)).toBe('9,500');
		expect(fmtTokens(12_340)).toBe('12.3k');
	});
	it('fmtCost precision varies by magnitude', () => {
		expect(fmtCost(1234)).toBe('$1234');
		expect(fmtCost(12.345)).toBe('$12.35');
		expect(fmtCost(0.012345)).toBe('$0.0123');
	});
	it('fmtDuration scales units', () => {
		expect(fmtDuration(500)).toBe('500ms');
		expect(fmtDuration(2100)).toBe('2.1s');
		expect(fmtDuration(65_000)).toBe('1.1m');
	});
	it('truncate cuts with ellipsis', () => {
		expect(truncate('abcdefghij', 5)).toBe('abcd…');
		expect(truncate('abc', 5)).toBe('abc');
	});
});
