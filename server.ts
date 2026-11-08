// bb-plugin-kimi-quota — shows Kimi Code membership quota in BB's usage panel.
//
// The built-in bb--provider-usage plugin discovers any plugin that exposes a
// discoverable RPC contract with the `provider-usage.v1.*` methods and renders
// its measurements next to the other providers (Codex, Claude, ...). This
// plugin is such a source: it reads the OAuth credential the Kimi Code CLI
// stores locally (~/.kimi-code/credentials/kimi-code.json), refreshes it when
// expired, and queries the same read-only endpoint the CLI's `/usage` slash
// command uses (GET {api}/coding/v1/usages).
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";

const LIST_RESOURCES = "provider-usage.v1.listResources";
const GET_RESOURCE = "provider-usage.v1.getResource";

const accountKeySchema = z.string().min(1).nullable().default(null);

const resourceSchema = z.object({
  accountKey: accountKeySchema,
  id: z.string().min(1),
  providerId: z.string().min(1),
  label: z.string().min(1),
  scope: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("shared") }),
    z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
  ]),
});

const measurementBase = {
  plan: z
    .object({ id: z.string().min(1), multiplier: z.number().int().positive().nullable() })
    .nullable()
    .default(null),
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
};

const windowSchema = z.object({
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]).default("custom"),
  id: z.string().min(1),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z
    .object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() })
    .nullable(),
});

const measurementSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("ok"), ...measurementBase, windows: z.array(windowSchema) }),
  z.object({ status: z.literal("not_installed"), ...measurementBase }),
  z.object({ status: z.literal("unauthenticated"), ...measurementBase }),
  z.object({ status: z.literal("expired"), ...measurementBase }),
  z.object({ status: z.literal("error"), ...measurementBase, message: z.string() }),
]);

export const rpcContract = defineRpcContract({
  [LIST_RESOURCES]: {
    input: z.object({}),
    output: z.object({ label: z.string().min(1).optional(), resources: z.array(resourceSchema) }),
    experimental_description:
      "Cheap complete inventory of resources owned by this source. Reads local metadata only; never refreshes quota or contacts providers. IDs are stable and source-local. Resource order is display order. Shared label preserves empty groups. Resources may disappear between list and fetch.",
  },
  [GET_RESOURCE]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: z.object({
      accountKey: accountKeySchema,
      observedAt: z.number().int().nonnegative().nullable(),
      usage: measurementSchema,
    }),
    experimental_description:
      "Returns actual usage for exactly one listed resource, even when refresh is false. False permits cached observations; true requests a fresh attempt. Never collects other resources as a side effect. A removed resource fails the RPC; consumers relist. Per-account authentication and collection failures are usage states. observedAt is the last successful measurement time.",
  },
});

// The same wire contract bb--provider-usage consumes from its built-in sources.
type Measurement = z.infer<typeof measurementSchema>;

const RESOURCE_ID = "kimi-code";
const CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098"; // public Kimi Code CLI client_id
const CACHE_MS = 60_000;

interface KimiCredential {
  access_token: string;
  refresh_token: string;
  expires_at?: number;
}

interface KimiUsageResponse {
  usages?: Record<
    string,
    { used_ratio?: number; reset_time?: string } | undefined
  >;
}

function kimiHome(): string {
  return process.env.KIMI_CODE_HOME ?? join(homedir(), ".kimi-code");
}

function credentialsPath(): string {
  return join(kimiHome(), "credentials", "kimi-code.json");
}

function isMainlandRegion(): boolean {
  try {
    return readFileSync(join(kimiHome(), "region"), "utf8").trim() === "mainland-cn";
  } catch {
    return false;
  }
}

function apiBase(): string {
  return isMainlandRegion() ? "https://api.kimi.com/coding/v1" : "https://api.kimi.ai/coding/v1";
}

function oauthHost(): string {
  return isMainlandRegion() ? "https://auth.kimi.com" : "https://auth.kimi.ai";
}

function readCredential(): KimiCredential | null {
  try {
    return JSON.parse(readFileSync(credentialsPath(), "utf8")) as KimiCredential;
  } catch {
    return null;
  }
}

// The refresh response rotates the refresh token, so persist the new pair
// atomically (temp file + rename, owner-only permissions) for the CLI and us.
async function refreshCredential(credential: KimiCredential): Promise<KimiCredential | null> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: credential.refresh_token,
    client_id: CLIENT_ID,
  });
  try {
    const response = await fetch(`${oauthHost()}/api/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };
    if (!data.access_token || !data.refresh_token) return null;
    const next: KimiCredential = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Math.floor(Date.now() / 1000) + (data.expires_in ?? 900),
    };
    const path = credentialsPath();
    const tmp = `${path}.tmp-${process.pid}`;
    writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return next;
  } catch {
    return null;
  }
}

async function validAccessToken(): Promise<string | null> {
  const credential = readCredential();
  if (!credential?.refresh_token) return null;
  const expiresAt = credential.expires_at ?? 0;
  if (expiresAt - 60 > Date.now() / 1000) return credential.access_token;
  const refreshed = await refreshCredential(credential);
  return refreshed?.access_token ?? null;
}

function accountKeyFromJwt(accessToken: string): string | null {
  try {
    const payload = JSON.parse(
      Buffer.from(accessToken.split(".")[1] ?? "", "base64url").toString("utf8"),
    ) as { sub?: string };
    return payload.sub ? `kimi-code:${payload.sub}` : null;
  } catch {
    return null;
  }
}

function baseMeasurement(): Measurement {
  return {
    status: "unauthenticated",
    plan: null,
    accountEmail: null,
    planLabel: "Kimi Code",
  };
}

async function collectUsage(): Promise<Measurement> {
  const token = await validAccessToken();
  if (!token) {
    return existsSync(credentialsPath())
      ? { ...baseMeasurement(), status: "expired" }
      : baseMeasurement();
  }
  let response: Response;
  try {
    response = await fetch(`${apiBase()}/usages`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    return { ...baseMeasurement(), status: "error", message: "Could not reach the Kimi API." };
  }
  if (response.status === 401 || response.status === 403) {
    return {
      ...baseMeasurement(),
      status: "expired",
      planLabel: "Kimi Code — run `kimi login` to re-authenticate",
    };
  }
  if (!response.ok) {
    return {
      ...baseMeasurement(),
      status: "error",
      message: `Kimi API returned HTTP ${response.status}.`,
    };
  }
  const data = (await response.json()) as KimiUsageResponse;
  const pct = (ratio: number | undefined) =>
    ratio === undefined ? 0 : Math.round(ratio * 1000) / 10;
  const windows = [
    {
      kind: "five-hour" as const,
      id: "5h",
      label: "5-hour window",
      usedPercent: pct(data.usages?.limit_5h?.used_ratio),
      resetsAt: data.usages?.limit_5h?.reset_time ?? null,
      model: null,
      cost: null,
    },
    {
      kind: "custom" as const,
      id: "month-code",
      label: "Monthly coding",
      usedPercent: pct(data.usages?.limit_month_code?.used_ratio),
      resetsAt: data.usages?.limit_month_code?.reset_time ?? null,
      model: null,
      cost: null,
    },
    {
      kind: "custom" as const,
      id: "month-total",
      label: "Monthly total",
      usedPercent: pct(data.usages?.limit_month_total?.used_ratio),
      resetsAt: data.usages?.limit_month_total?.reset_time ?? null,
      model: null,
      cost: null,
    },
  ];
  return { status: "ok", plan: null, accountEmail: null, planLabel: "Kimi Code", windows };
}

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const cache = new Map<string, { usage: Measurement; observedAt: number | null }>();

  async function collect(resourceId: string, refresh: boolean) {
    const cached = cache.get(resourceId);
    if (
      !refresh &&
      cached &&
      cached.usage.status === "ok" &&
      cached.observedAt !== null &&
      Date.now() - cached.observedAt < CACHE_MS
    ) {
      return cached;
    }
    const usage = await collectUsage();
    const observedAt = usage.status === "ok" ? Date.now() : (cached?.observedAt ?? null);
    const next = { usage, observedAt };
    cache.set(resourceId, next);
    return next;
  }

  bb.rpc.register(
    rpcContract,
    {
      [LIST_RESOURCES]: async () => {
        // The usage panel groups host resources into the selected machine's
        // card. A shared resource instead creates a separate source menu item.
        // These credentials live on the BB server, so use its primary host.
        const host = await (async () => {
          try {
            const { primaryHostId } = await bb.sdk.system.config();
            return primaryHostId ? await bb.sdk.hosts.get({ hostId: primaryHostId }) : null;
          } catch {
            return null;
          }
        })();
        const credential = readCredential();
        const accountKey =
          credential && credential.expires_at && credential.expires_at > Date.now() / 1000
            ? accountKeyFromJwt(credential.access_token)
            : null;
        return {
          ...(host ? {} : { label: "Kimi Code" }),
          resources: [
            {
              id: RESOURCE_ID,
              accountKey,
              providerId: "kimi-code",
              label: "Kimi Code membership",
              scope: host
                ? { kind: "host" as const, hostId: host.id, hostName: host.name }
                : { kind: "shared" as const },
            },
          ],
        };
      },
      [GET_RESOURCE]: async ({ resourceId, refresh }) => {
        if (resourceId !== RESOURCE_ID) throw new Error("Usage resource no longer exists.");
        const { usage, observedAt } = await collect(resourceId, refresh);
        const credential = readCredential();
        return {
          accountKey: credential ? accountKeyFromJwt(credential.access_token) : null,
          observedAt,
          usage,
        };
      },
    },
    {
      experimental_discoverable: true,
      experimental_description:
        "Kimi Code membership quota from the Kimi Code CLI login on the BB server, shown alongside that machine's other provider limits.",
    },
  );

  // `bb kimi-quota [--json]` — the same numbers for the shell and for agents.
  bb.cli.register({
    name: "kimi-quota",
    summary: "Show Kimi Code membership quota (5h window, monthly limits)",
    commands: [{ name: "show", summary: "Show current quota", usage: "bb kimi-quota [--json]" }],
    async run(argv) {
      const json = argv.includes("--json");
      const { usage, observedAt } = await collect(RESOURCE_ID, true);
      if (json) return { exitCode: 0, stdout: JSON.stringify({ usage, observedAt }) };
      if (usage.status !== "ok") {
        return { exitCode: 1, stdout: `Kimi quota unavailable: ${usage.status}` };
      }
      const lines = usage.windows.map(
        (w) =>
          `${w.label.padEnd(16)} ${String(w.usedPercent).padStart(5)}% used  resets ${w.resetsAt ?? "—"}`,
      );
      return { exitCode: 0, stdout: lines.join("\n") };
    },
  });

  bb.onDispose(() => {
    cache.clear();
    bb.log.info("disposed");
  });
}
