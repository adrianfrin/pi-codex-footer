import { test } from "node:test";
import assert from "node:assert/strict";
import footer, { creditSegments, localTime, formatTokens, modelLabel, quotaSegments } from "../src/index.ts";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { UsageReport } from "@narumitw/pi-usage/src/types.ts";
const report = (buckets: UsageReport["buckets"]): UsageReport => ({ providerId: "openai-codex", providerName: "Codex", capturedAt: Date.now(), source: "test", semantics: { kind: "consumer-subscription", label: "Test" }, buckets, metrics: [] });
const model = { provider: "openai-codex", id: "gpt-test", name: "GPT Test" };

test("token formatting covers unknown, zero, thousands and millions", () => {
  assert.equal(formatTokens(undefined), "?"); assert.equal(formatTokens(NaN), "?");
  assert.equal(formatTokens(0), "0"); assert.equal(formatTokens(174100), "174.1K"); assert.equal(formatTokens(1000000), "1M");
});
test("model suffix contains level without the word Thinking", () => {
  assert.equal(modelLabel({ id: "gpt-test", reasoning: true }, "low"), "gpt-test-low");
  assert.equal(modelLabel({ id: "other", reasoning: false }, "off"), "other");
  assert.equal(modelLabel(undefined, "low"), "No model");
});
test("missing quota and reset credits are hidden", () => {
  assert.deepEqual(quotaSegments(undefined, model), []); assert.deepEqual(creditSegments(undefined), []);
  assert.deepEqual(quotaSegments(report([]), model), []);
});
test("weekly-primary is not mislabeled as 5h", () => {
  const segments = quotaSegments(report([{ id: "codex:primary", groupId: "codex", label: "Primary", unit: "percent", remaining: 28, windowMinutes: 10080, resetsAt: 1800000000 }]), model);
  assert.equal(segments.length, 1); assert(segments[0].text.startsWith("Week 28% left (resets "));
});
test("both windows render; missing reset timestamps are omitted", () => {
  const segments = quotaSegments(report([
    { id: "codex:primary", groupId: "codex", label: "Primary", unit: "percent", remaining: 90, windowMinutes: 300 },
    { id: "codex:secondary", groupId: "codex", label: "Secondary", unit: "percent", remaining: 10, windowMinutes: 10080 },
  ]), model);
  assert.equal(segments[0].text, "5h 90% left"); assert.equal(segments[1].text, "Week 10% left");
  assert.equal(segments[1].color, "error");
});
test("model-specific group overrides generic Codex quota", () => {
  const segments = quotaSegments(report([
    { id: "codex:primary", groupId: "codex", label: "Primary", unit: "percent", remaining: 90, windowMinutes: 300 },
    { id: "gpt-test:primary", groupId: "gpt-test", label: "Model", unit: "percent", remaining: 15, windowMinutes: 300 },
  ]), model);
  assert.equal(segments[0].text, "5h 15% left"); assert.equal(segments[0].color, "warning");
});
test("known zero is preserved, unknown expiry is not invented", () => {
  assert.equal(creditSegments({ availableCount: 0, options: [] })[0].text, "0 resets");
  assert.equal(creditSegments({ availableCount: 1, options: [] })[0].text, "1 reset");
  assert.deepEqual(creditSegments({ availableCount: NaN, options: [] }), []);
});
test("earliest known expiration is chosen, invalid date is hidden", () => {
  const result = creditSegments({ availableCount: 2, options: [
    { creditId: "a", title: "A", description: "", expiresAt: 1800000000 },
    { creditId: "b", title: "B", description: "", expiresAt: 1790000000 },
  ] });
  assert.equal(result[0].text, `2 resets (next expires ${localTime(1790000000)})`);
  assert.equal(localTime(NaN), "?"); assert.equal(localTime(Infinity), "?");
});
test("footer lifecycle renders bounded lines and cleans up; no quota request for other providers", () => {
  const events = new Map<string, Function>();
  let rendered: { render: (width: number) => string[] } | undefined;
  footer({ on: (key: string, callback: Function) => events.set(key, callback), registerCommand() {}, getThinkingLevel: () => "low" } as unknown as ExtensionAPI);
  const theme = { fg: (_color: string, text: string) => text };
  const ctx = { mode: "tui", model: { id: "test-model", provider: "other", reasoning: true, contextWindow: 1000000 }, thinkingLevel: "low", getContextUsage: () => ({ tokens: 174100, contextWindow: 1000000, percent: 17.41 }), ui: { setFooter: (factory: Function) => { rendered = factory({ requestRender() {} }, theme); } } } as unknown as ExtensionContext;
  events.get("session_start")!({}, ctx);
  try {
    assert(rendered);
    for (const width of [0, 1, 20, 40, 120]) assert(rendered.render(width).every(line => visibleWidth(line) <= width));
    assert.equal(rendered.render(120).join(""), "test-model-low · Context 174.1K/1M");
  } finally { events.get("session_shutdown")!(); }
});
