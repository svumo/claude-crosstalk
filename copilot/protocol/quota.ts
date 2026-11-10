// The GitHub Copilot account's monthly meter, as GitHub reports it. Pure.
//
// `gh api copilot_internal/user` answers with the account's plan and a quota snapshot per kind of
// use. Chat and completions are unlimited on paid plans; `premium_interactions` is the one that
// counts AI credits against the month's allowance. This is the same endpoint Copilot's own editor
// extensions read. GitHub does not document it, so anything unexpected reads as "no meter".
// It needs no scope beyond what `gh auth login` grants.

export const QUOTA_ARGV = ["gh", "api", "copilot_internal/user"] as const;

export type Quota = {
  plan: string;
  used: number;
  entitlement: number;
  remaining: number;
  // 0-100, as GitHub works it out.
  percentUsed: number;
  unlimited: boolean;
  overagePermitted: boolean;
  overage: number;
  // yyyy-mm-dd, or "" when GitHub gives none.
  resetDate: string;
};

const num = (value: unknown): number | null => (typeof value === "number" && Number.isFinite(value) ? value : null);

export function parseQuota(text: string): Quota | null {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof data !== "object" || data === null) {
    return null;
  }
  const d = data as { copilot_plan?: unknown; quota_reset_date?: unknown; quota_snapshots?: { premium_interactions?: Record<string, unknown> } };
  const premium = d.quota_snapshots?.premium_interactions;
  if (typeof premium !== "object" || premium === null) {
    return null;
  }
  const entitlement = num(premium.entitlement) ?? 0;
  const remaining = num(premium.quota_remaining) ?? num(premium.remaining) ?? 0;
  const used = num(premium.credits_used) ?? Math.max(0, entitlement - remaining);
  const left = num(premium.percent_remaining);
  const unlimited = premium.unlimited === true;
  const percentUsed = unlimited ? 0 : left !== null ? Math.min(100, Math.max(0, 100 - left)) : entitlement > 0 ? Math.min(100, (used / entitlement) * 100) : 0;
  const reset = typeof d.quota_reset_date === "string" && /^\d{4}-\d{2}-\d{2}/.test(d.quota_reset_date) ? d.quota_reset_date.slice(0, 10) : "";
  return {
    plan: typeof d.copilot_plan === "string" ? d.copilot_plan : "",
    used, entitlement, remaining, percentUsed, unlimited,
    overagePermitted: premium.overage_permitted === true,
    overage: num(premium.overage_count) ?? 0,
    resetDate: reset,
  };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

// "2026-12-01" → "1 Dec".
export function resetLabel(date: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  const month = match ? MONTHS[Number(match[2]) - 1] : undefined;
  return match && month ? `${Number(match[3])} ${month}` : "";
}

// 5642 → "5,642"; 50000 → "50k"; 1250000 → "1.3M". Whole credits; the meter is not a bill.
export function credits(n: number, short = false): string {
  const whole = Math.round(n);
  if (short && Math.abs(whole) >= 1_000_000) {
    return `${(whole / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (short && Math.abs(whole) >= 10_000) {
    return `${(whole / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return whole.toLocaleString("en-US");
}

// What the meter says in words, for a line under a result or in /crosstalk-gh status.
export function quotaLine(q: Quota): string {
  if (q.unlimited) {
    return `GitHub Copilot (${q.plan || "plan"}): premium use unlimited.`;
  }
  const reset = resetLabel(q.resetDate);
  const over = q.overage > 0 ? `, ${credits(q.overage)} over` : "";
  return `GitHub Copilot this month: ${credits(q.used)} of ${credits(q.entitlement)} AI credits used (${Math.round(q.percentUsed)}%${over})${reset ? `, resets ${reset}` : ""}.`;
}

// How far the account's meter moved between two readings, for a task's result. GitHub's figure is
// the whole account's, can lag a few minutes, and counts other Copilot use in that time too.
export function movedLine(before: Quota | null, after: Quota | null): string {
  if (!before || !after || after.unlimited) {
    return "";
  }
  if (after.resetDate !== before.resetDate || after.used < before.used) {
    return `GitHub's meter reset while the task ran; now ${credits(after.used)} of ${credits(after.entitlement)} AI credits used this month.`;
  }
  const moved = after.used - before.used;
  return `GitHub's meter: ${credits(after.used)} of ${credits(after.entitlement)} AI credits used this month, ${moved === 0 ? "no change yet (it can lag a few minutes)" : `up ${credits(moved)} while the task ran (all Copilot use on the account counts; it can lag a few minutes)`}.`;
}
