// Read-only usage/reset-credit queries reuse the pinned pi-usage dependency.
// Only helpers are imported; the upstream extension is not registered.
// No reset consumption endpoint is called.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { adapterForProvider, resolveUsageAuth, queryProviderUsage } from "@narumitw/pi-usage/src/query.ts";
import { listCodexResetCredits, type CodexResetAvailability } from "@narumitw/pi-usage/src/codex-resets.ts";
import { formatUsageStatusline } from "@narumitw/pi-usage/src/format.ts";
import type { UsageReport, UsageModel } from "@narumitw/pi-usage/src/types.ts";

type Segment = { text: string; color: "dim" | "warning" | "error" };
export function formatTokens(value: number | null | undefined): string {
  if (value == null || !Number.isFinite(value) || value < 0) return "?";
  if (value < 1000) return String(Math.round(value));
  const unit = value < 1e6 ? 1000 : 1e6;
  return `${Number((value / unit).toFixed(1))}${unit === 1000 ? "K" : "M"}`;
}
export function localTime(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds)) return "?";
  const date = new Date(seconds * 1000);
  if (!Number.isFinite(date.getTime())) return "?";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
export function creditSegments(credits: CodexResetAvailability | undefined): Segment[] {
  const available = credits?.options.filter(o => o.creditId) ?? [];
  const expiry = available.map(o => o.expiresAt).filter((n): n is number => n !== undefined && Number.isFinite(n));
  const count = credits?.availableCount;
  if (count === undefined || !Number.isSafeInteger(count) || count < 0) return [];
  const expiration = count > 0 && expiry.length ? localTime(Math.min(...expiry)) : "?";
  return [{ text: `${count} reset${count === 1 ? "" : "s"}${expiration !== "?" ? ` (next expires ${expiration})` : ""}`, color: "dim" }];
}

export function quotaSegments(report: UsageReport | undefined, model?: UsageModel): Segment[] {
  if (!report) return [];
  const selected = formatUsageStatusline(report, model, Date.now(), false);
  const group = [...new Set(report.buckets.map(b => b.groupId ?? b.id))].find(id => {
    const isolated = { ...report, buckets: report.buckets.filter(b => (b.groupId ?? b.id) === id) };
    return formatUsageStatusline(isolated, model, Date.now(), false) === selected;
  });
  const buckets = report.buckets.filter(b => (b.groupId ?? b.id) === group);
  const segments: Segment[] = [];
  for (const [label, minutes, position] of [["5h", 300, ":primary"], ["Week", 10080, ":secondary"]] as const) {
    // Window duration wins over position: some accounts return a week as primary.
    const bucket = buckets.find(b => b.windowMinutes === minutes) ?? buckets.find(b => b.windowMinutes === undefined && b.id.endsWith(position));
    const remaining = bucket?.remaining;
    if (remaining === undefined || !Number.isFinite(remaining)) continue;
    const reset = localTime(bucket?.resetsAt);
    segments.push({ text: `${label} ${Math.round(remaining)}% left${reset !== "?" ? ` (resets ${reset})` : ""}`, color: remaining <= 10 ? "error" : remaining <= 20 ? "warning" : "dim" });
  }
  return segments;
}

export function modelLabel(model: { id: string; reasoning?: boolean } | undefined, level: string): string {
  return model ? `${model.id}${model.reasoning ? `-${level}` : ""}` : "No model";
}

export default function codexFooter(pi: ExtensionAPI) {
  let report: UsageReport | undefined;
  let credits: CodexResetAvailability | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  let repaint = () => {};
  let loading = false;
  let failed = false;
  const clear = () => {
    generation++; controller?.abort(); controller = undefined;
    report = undefined; credits = undefined; loading = false; failed = false;
  };
  const refresh = async (ctx: ExtensionContext) => {
    if (loading || ctx.model?.provider !== "openai-codex") return;
    const model = ctx.model, epoch = generation;
    const abort = new AbortController(); controller = abort; loading = true;
    try {
      const adapter = adapterForProvider("openai-codex")!;
      const auth = await resolveUsageAuth(ctx, adapter);
      if (!auth || abort.signal.aborted) throw new Error("Unavailable");
      const [usageResult, creditsResult] = await Promise.allSettled([
        queryProviderUsage(adapter, auth, abort.signal, 10000),
        listCodexResetCredits(auth, abort.signal, 10000),
      ]);
      if (epoch !== generation || abort.signal.aborted || ctx.model?.id !== model.id || ctx.model?.provider !== model.provider) return;
      // Revalidate active credentials so an in-flight result cannot cross accounts.
      const currentAuth = await resolveUsageAuth(ctx, adapter);
      if (epoch !== generation || abort.signal.aborted) return;
      if (!currentAuth || currentAuth.fingerprint !== auth.fingerprint) { report = undefined; credits = undefined; failed = true; return; }
      report = usageResult.status === "fulfilled" ? usageResult.value : undefined;
      credits = creditsResult.status === "fulfilled" ? creditsResult.value : undefined;
      failed = usageResult.status === "rejected" || creditsResult.status === "rejected";
    } catch {
      if (epoch === generation) { report = undefined; credits = undefined; failed = true; }
    } finally {
      if (epoch === generation) { loading = false; repaint(); }
    }
  };
  pi.on("session_shutdown", () => { clear(); if (timer) clearInterval(timer); timer = undefined; repaint = () => {}; });
  pi.on("model_select", (_event, ctx) => { clear(); repaint(); if (ctx.mode === "tui") void refresh(ctx); });
  pi.registerCommand("quota-refresh", { description: "Refresh footer quota and reset-credit expiration (read only)", handler: async (_args, ctx) => {
    clear(); await refresh(ctx);
    ctx.ui.notify(failed ? "Some quota data is unavailable; no reset was consumed." : "Footer quota refreshed. No reset consumed.", failed ? "warning" : "info");
  } });
  pi.on("session_start", (_event, ctx) => {
    if (ctx.mode !== "tui") return;
    clear();
    ctx.ui.setFooter((tui, theme) => {
      repaint = () => tui.requestRender();
      return { invalidate() {}, render(width: number): string[] {
        if (width <= 0) return [];
        const usage = ctx.getContextUsage();
        const percent = usage?.percent;
        const segments: Segment[] = [
          { text: modelLabel(ctx.model, ctx.thinkingLevel ?? pi.getThinkingLevel()), color: "dim" },
          { text: `Context ${formatTokens(usage?.tokens)}/${formatTokens(usage?.contextWindow ?? ctx.model?.contextWindow)}`, color: percent != null && percent >= 95 ? "error" : percent != null && percent >= 80 ? "warning" : "dim" },
        ];
        if (ctx.model?.provider === "openai-codex") {
          segments.push(...quotaSegments(report, ctx.model), ...creditSegments(credits));
          // Missing fields and transient API errors stay out of the footer.
          // Explicit /quota-refresh still reports request failures.
        }
        const separator = theme.fg("dim", " · "), lines: string[] = [];
        let line = "";
        for (const segment of segments) {
          const text = truncateToWidth(theme.fg(segment.color, segment.text), width, "…");
          if (line && visibleWidth(line + separator + text) > width) { lines.push(line); line = text; }
          else line = line ? line + separator + text : text;
        }
        if (line) lines.push(line);
        return lines;
      } };
    });
    void refresh(ctx);
    if (timer) clearInterval(timer);
    timer = setInterval(() => void refresh(ctx), 60000);
    timer.unref?.();
  });
}
