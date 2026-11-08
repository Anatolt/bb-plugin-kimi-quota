# Kimi Quota

Shows your Kimi Code membership quota in BB's usage panel — the same surface
that displays Codex and Claude usage — and exposes it to agents.

- `server.ts` — the backend: a discoverable `provider-usage.v1` source that
  the built-in usage panel renders, plus a `bb kimi-quota` CLI command.
- `skills/kimi-quota/SKILL.md` — tells agents how to read the quota.
- `PLUGIN_OVERVIEW.md` — the store listing text.

## How it works

The plugin reads the OAuth credential the Kimi Code CLI stores locally
(`~/.kimi-code/credentials/kimi-code.json`), refreshes the short-lived access
token through Kimi's OAuth endpoint when it expires, and queries the same
read-only endpoint the CLI's `/usage` slash command uses. It writes the rotated
token pair back atomically, so the CLI keeps working.

The API host follows the CLI region (`api.kimi.com` for `mainland-cn`,
`api.kimi.ai` otherwise).

## Usage panel

Install the plugin and open BB's usage panel with the BB server's machine
selected. **Kimi Code** appears in the same card as that machine's Codex/Claude
limits, with no separate Kimi source to select. It shows the 5-hour rolling
window and the monthly coding/total limits with reset times.

The login is read on the BB server, not on enrolled remote machines. If BB
cannot identify its server machine, Kimi remains available as a separate
**Kimi Code** source in the panel's menu.

## Terminal

```
bb kimi-quota            # human-readable
bb kimi-quota --json     # full measurement JSON
```

## Requirements

- Kimi Code CLI installed and logged in on the machine that runs the BB server.
- A Kimi membership that includes Kimi Code.

## License

MIT
