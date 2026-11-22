# zcusage

[![CI](https://github.com/ecoreal/zcusage/actions/workflows/ci.yml/badge.svg)](https://github.com/ecoreal/zcusage/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

**ccusage for ZCode** — usage, cost & performance analytics for your ZCode agent sessions. Reads the local SQLite telemetry ZCode already records, prints clean tables, never touches message content, never phones home. **Zero runtime dependencies** — one bundled JS file on Node ≥ 24.

```
$ zcusage status
metric                   value
period                   2026-10-27 → 2026-11-23
sessions                 152
model requests           4,003
total tokens             590.64M
  input                  298.97M
  output                 2.74M
  cache read             288.93M
estimated cost           $217
errors / cancelled       86 / 30
avg time to first token  4.4s
tool calls               5,014
  destructive calls      0
  network calls          253
```

## Why

ccusage proved people want to know what their coding agent spends. ZCode already records *richer* telemetry than Claude Code does — request-level token counts, cache traffic, time-to-first-token, retries, error taxonomy, and a full tool-call ledger with `destructive` / `network` / `read-only` flags — but ships no analyzer for it. zcusage is that analyzer.

What you get beyond daily token tables:

- **Cost estimates** — builtin price table for popular models, `pricing --update` pulls LiteLLM's full table, `--pricing` takes your own. Unknown models are reported as unknown, never guessed.
- **Latency & reliability** — p50 TTFT, average duration, error/cancel/retry counts per model. Spot a slow or flaky provider instantly.
- **Subagent share** — `agents` shows how much of your spend is the main agent vs spawned subagents.
- **Tool risk profile** — `tools` counts destructive and network-touching calls per tool; a security lens nobody else ships.
- **Everything stays local** — read-only SQLite access, no network calls unless you ask for a pricing table.

## Install

Requires Node ≥ 24 (uses the builtin `node:sqlite`).

```bash
git clone https://github.com/ecoreal/zcusage && cd zcusage
npm install && npm run build
node dist/cli.js status

# optional: install globally
npm link
zcusage daily
```

## Commands

| Command | Shows |
|---|---|
| `daily` *(default)* | Per-day requests, token split (input/output/cache read/write), cost |
| `session` | Per-session tokens & cost, with title and project, newest first (`--top n`) |
| `model` | Per-model: requests, tokens, cost, p50 TTFT, avg duration, errors/cancels |
| `agents` | Main agent vs subagent usage split |
| `tools` | Per-tool calls, errors, destructive / network counts, avg duration & output |
| `status` | Whole-history summary |
| `pricing` | Show pricing source; `--update` fetches LiteLLM's table |

Useful flags: `--db <path>` (custom database), `--since/--until YYYY-MM-DD`, `--json`, `--no-cost`, `--pricing <file>`, `--top n`. The database path defaults to `~/.zcode/cli/db/db.sqlite` (override with `ZCODE_DB`).

## Pricing

Three layers, later wins:

1. **Builtin** — hand-curated per-MTok prices for popular Claude / GPT / Gemini / GLM / Kimi / DeepSeek models. Best-effort; review dates in source.
2. **Cache** — `zcusage pricing --update` downloads [LiteLLM's pricing JSON](https://github.com/BerriAI/litellm/blob/main/model_prices_and_context_window.json) to `~/.cache/zcusage/pricing.json`.
3. **`--pricing <file>`** — your own table. Accepts LiteLLM format or a simple map; per-MTok values (`"input": 3`) are auto-scaled, per-token values (`3e-6`) pass through.

```json
{ "glm-5.3-flash": { "input": 0.6, "output": 2.2, "cacheRead": 0.11 } }
```

Costs follow Anthropic token semantics (input excludes cache traffic; cache reads ≈ 0.1×, cache writes ≈ 1.25× of the input rate; reasoning treated as included in output). Subscription plans make these estimates an upper bound for people paying flat fees — treat them as "what this would have cost on pay-as-you-go". A `*` marks lower bounds where some models lack prices.

## Privacy

zcusage reads only the `model_usage` / `tool_usage` / `session` telemetry tables — token counts, durations, tool names, flags, timestamps. **Prompts, responses and file contents are never read**, and nothing is sent anywhere. The database is opened read-only (falling back to a temp copy if the filesystem refuses read-only WAL access).

## Development

```bash
npm test          # vitest (40 tests, synthetic SQLite fixtures — no real data touched)
npm run build     # typecheck + esbuild bundle → dist/cli.js
npm run dev       # watch mode
```

Works on Linux / macOS / Windows wherever Node ≥ 24 and a ZCode data directory exist.

## Roadmap

- [ ] npm publish (`npx zcusage` without cloning)
- [ ] JSONL rollout fallback (`~/.zcode/cli/rollout/*.jsonl`) for machines without the SQLite store
- [ ] `--project <dir>` filter and per-project rollups
- [ ] HTML/TUI dashboard
- [ ] `zcode` provider plugin / marketplace distribution

## License

MIT
