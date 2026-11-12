import type { RestockCooldown } from "../agent/restock-cooldown";
import type { InsightRow, InsightsSnapshot } from "./types";
import { usd } from "../format";

export type WorkspaceProduct = {
  variantId: string;
  cooldown?: RestockCooldown | null;
  automaticRestocks?: number;
  paidRestocks?: number;
  purchaseCount?: number;
  amount?: number;
  settled?: number;
  reserved?: number;
  blocked?: number;
  title: string;
  sku: string | null;
  supplier: string | null;
  stock: number;
  incoming: number;
  cover: number | null;
  perDay?:number;
  dailySalesOverride?: number | null;
  managed: boolean;
  status: { label: string; tone: string; at?: string };
};
export type WorkspaceActivity = {
  seq: number;
  at: string;
  kind: string;
  title: string;
  detail?: string;
};
export type WorkspaceDetail = {
  id: string;
  category: string;
  setting: string;
  value: string;
  href?: string;
};
export type WorkspaceSummary = {
  spentCents: number;
  reservedCents: number;
  remainingCents: number;
  capCents: number;
  balanceCents: number | null;
  waiting: number;
  blocked: number;
};
export type HomeWorkspaceData = {
  suppliers?: { id: string; name: string; addedAt: string }[] | null;
  policy?: { reorderBelowDays: number; cashFloorCents: number } | null;
  products: WorkspaceProduct[] | null;
  activity: WorkspaceActivity[];
  details: WorkspaceDetail[];
  summary: WorkspaceSummary;
};
type HomeInput = {
  suppliers?: { id: string; name: string; addedAt: string }[] | null;
  products: WorkspaceProduct[] | null;
  recent: WorkspaceActivity[];
  spentCents: number;
  budget: { reserved: number; remaining: number };
  balanceCents: number | null;
  waiting: number;
  blocked: { count: number };
  head: string | null;
  chain: { valid: boolean; length?: number };
  signed: { by: string; at: string } | null;
  rules: {
    approvalAbove: string;
    weeklyCapCents: number;
    cashFloorCents: number;
    reorderBelow: number;
    allowlist: string[];
  } | null;
};
export function homeWorkspace(data: HomeInput): HomeWorkspaceData {
  const rows: WorkspaceDetail[] = [];
  const add = (
    category: string,
    setting: string,
    value: string,
    href?: string,
  ) =>
    rows.push({ id: `${category}:${setting}`, category, setting, value, href });
  if (data.rules) {
    add(
      "Spending rules",
      "Approval required above",
      data.rules.approvalAbove,
      "/app/rules?tab=rules",
    );
    add("Spending rules", "7-day spending cap", usd(data.rules.weeklyCapCents));
    add(
      "Spending rules",
      "Minimum PayPal balance",
      usd(data.rules.cashFloorCents),
    );
    add(
      "Spending rules",
      "Restock below",
      `${data.rules.reorderBelow} days of stock`,
    );
    add("Spending rules", "Allowed suppliers", data.rules.allowlist.join(", "));
  } else
    add("Spending rules", "Rules", "Not signed yet", "/app/rules?tab=rules");
  add(
    "Spending rules",
    "Last signed",
    data.signed ? `${data.signed.by} · ${data.signed.at}` : "Not signed yet",
  );
  add(
    "Audit trail",
    "Verification",
    data.chain.valid
      ? `Audit log intact · ${data.chain.length} entries`
      : "Audit log failed verification",
    "/app/activity",
  );
  add(
    "Audit trail",
    "Fingerprint",
    data.head ?? "No entries yet",
    "/app/activity",
  );
  return {
    policy: data.rules
      ? {
          reorderBelowDays: data.rules.reorderBelow,
          cashFloorCents: data.rules.cashFloorCents,
        }
      : null,
    suppliers: data.suppliers ?? null,
    products: data.products,
    activity: data.recent.map(({ seq, at, kind, title, detail }) => ({
      seq,
      at,
      kind,
      title,
      detail,
    })),
    details: rows,
    summary: {
      spentCents: data.spentCents,
      reservedCents: data.budget.reserved,
      remainingCents: data.budget.remaining,
      capCents: data.rules?.weeklyCapCents ?? 0,
      balanceCents: data.balanceCents,
      waiting: data.waiting,
      blocked: data.blocked.count,
    },
  };
}
export function purchasesForProduct(rows: InsightRow[], variantId: string) {
  return rows.filter((row) => row.variantId === variantId);
}
/** Entirely fictional browser-only data: no live store identities or links. */
export function demoWorkspace(snapshot: InsightsSnapshot): HomeWorkspaceData {
  const products = [
    ...new Map(snapshot.rows.map((row) => [row.variantId, row])).values(),
  ].map((row, index): WorkspaceProduct => ({
    variantId: row.variantId ?? `demo-${index}`,
    title: row.product,
    sku: `EXAMPLE-${index + 1}`,
    supplier: row.supplier,
    stock: index === 0 ? 2 : (index + 1) * 4,
    incoming: index % 3 === 0 ? 6 : 0,
    cover: index === 0 ? 1 : (index + 1) * 2,
    managed: index % 4 !== 3,
    status: {
      label:
        index === 0
          ? "Low stock · awaiting restock check"
          : index % 3 === 0
            ? "Awaiting delivery"
            : "Stock sufficient",
      tone: index === 0 ? "warning" : "success",
    },
  }));
  const s = snapshot.summary;
  return {
    products,
    suppliers: [
      ...[...new Set(snapshot.rows.map((row) => row.supplier))].map(
        (name, index) => ({
          id: `demo-supplier-${index}`,
          name,
          addedAt: snapshot.checkedAt,
        }),
      ),
      {
        id: "demo-supplier-untraded",
        name: "Northfield Supplies",
        addedAt: snapshot.checkedAt,
      },
    ],
    policy: { reorderBelowDays: 7, cashFloorCents: 100000 },
    summary: {
      ...s,
      balanceCents: null,
      waiting: snapshot.rows.filter((row) => row.status === "Needs approval")
        .length,
      blocked: s.blockedCount,
    },
    activity: snapshot.rows.map((row) => ({
      seq: row.purchase,
      at: row.proposedAt,
      kind: "Example purchase",
      title: `Fictional purchase #${row.purchase}: ${row.product} · ${row.status}`,
    })),
    details: [
      {
        id: "demo-cap",
        category: "Example rules",
        setting: "7-day spending cap",
        value: usd(s.capCents),
      },
      {
        id: "demo-floor",
        category: "Example rules",
        setting: "Minimum PayPal balance",
        value: usd(100000),
      },
      {
        id: "demo-audit",
        category: "Demo",
        setting: "Store records",
        value: "Fictional browser data · no audit entries or payments created",
      },
    ],
  };
}
