---
name: kimi-quota
description: Check the user's Kimi Code membership quota (5-hour window, monthly coding/total limits) inside BB, either from the UI usage panel or with `bb kimi-quota`.
---

# Kimi Quota

This plugin surfaces the Kimi Code membership quota in BB's usage panel (the
same surface that shows Codex/Claude usage) and exposes a CLI command.

## For agents

Run:

```
bb kimi-quota            # human-readable bars
bb kimi-quota --json     # full measurement JSON
```

The numbers come from the Kimi Code CLI login on this machine
(`~/.kimi-code/credentials/kimi-code.json`, region-aware: `api.kimi.com` for
`mainland-cn`, `api.kimi.ai` otherwise). The access token lives 15 minutes;
the plugin refreshes it through Kimi's OAuth endpoint and writes the rotated
pair back to the credentials file atomically, so the CLI keeps working.

States other than `ok`: `unauthenticated` (no CLI login — `kimi login`),
`expired` (re-auth needed), `error` (API unreachable).
