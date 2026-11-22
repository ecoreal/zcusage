import { run, UsageError } from './cli.js';

try {
	const out = await run(process.argv.slice(2));
	if (out) console.log(out);
} catch (err) {
	if (err instanceof UsageError) {
		console.error(`zcusage: ${err.message}`);
	} else {
		const msg = err instanceof Error ? err.message : String(err);
		console.error(`zcusage: ${msg}`);
	}
	process.exit(1);
}
