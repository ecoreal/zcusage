/** Plain-text table rendering and number formatting (zero dependencies). */

export interface Cell {
	text: string;
	align?: 'left' | 'right';
}

export function renderTable(headers: string[], rows: Cell[][]): string {
	const widths: number[] = headers.map((h) => h.length);
	for (const row of rows) {
		row.forEach((cell, i) => {
			widths[i] = Math.max(widths[i], cell.text.length);
		});
	}
	const line = (cells: Cell[], header = false): string => {
		const rendered = cells.map((cell, i) => {
			const w = widths[i];
			const pad = w - cell.text.length;
			return cell.align === 'right' ? ' '.repeat(pad) + cell.text : cell.text + ' '.repeat(pad);
		});
		// header rows default-align left
		void header;
		return rendered.join('  ');
	};
	const out: string[] = [];
	out.push(
		line(
			headers.map((h) => ({ text: h, align: /tok|usd|req|cost|avg|p50|err|ms/i.test(h) ? 'right' : 'left' })),
			true
		)
	);
	for (const row of rows) out.push(line(row));
	return out.join('\n');
}

/** 1234567 → "1,234,567" */
export function fmtInt(n: number): string {
	return Math.round(n).toLocaleString('en-US');
}

/** 1_234_567 → "1.2M"; under 10k prints plain with commas. */
export function fmtTokens(n: number): string {
	const abs = Math.abs(n);
	if (abs >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
	if (abs >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
	if (abs >= 10_000) return `${(n / 1e3).toFixed(1)}k`;
	return fmtInt(n);
}

/** 12.3456 → "$12.35"; 0.0123 → "$0.0123" (keeps 4 decimals under $1). */
export function fmtCost(usd: number): string {
	if (usd >= 100) return `$${usd.toFixed(0)}`;
	if (usd >= 1) return `$${usd.toFixed(2)}`;
	return `$${usd.toFixed(4)}`;
}

/** 987654 ms → "16.5m"; 9876 → "9.9s"; 876 → "876ms" */
export function fmtDuration(ms: number): string {
	if (ms >= 3_600_000) return `${(ms / 3_600_000).toFixed(1)}h`;
	if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
	if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.round(ms)}ms`;
}

/** ISO date or short local datetime for epoch-ms timestamps. */
export function fmtTimestamp(epochMs: number | null): string {
	if (epochMs === null) return '-';
	const d = new Date(epochMs);
	const pad = (v: number): string => String(v).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** Truncate with ellipsis, counting width naively. */
export function truncate(text: string, max: number): string {
	if (text.length <= max) return text;
	return text.slice(0, Math.max(0, max - 1)) + '…';
}
