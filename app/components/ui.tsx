// Shared Polaris-native building blocks for GuardBuy's admin pages (browser-safe: no server code).

export type Tone = "success" | "caution" | "warning" | "critical" | "info" | "neutral";

/** "just now", "5 min ago", "3 h ago", "yesterday", "2 days ago" */
export function ago(iso: string, now: number) {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// Activity types: badge tone keeps the palette's meaning (success = money moved,
// caution = needs a person, critical = stopped, info = the AI / information).
export const FEED_TONE: Record<string, Tone> = {
  paid: "success", approved: "success", resisted: "success", auto: "success",
  block: "critical", failed: "critical", slipped: "critical",
  approval: "caution", flagged: "caution", declined: "neutral",
  proposed: "info", attack: "info", stock: "info", paypal: "info", rules: "neutral", status: "neutral",
};
export const FEED_LABEL: Record<string, string> = {
  paid: "Paid", approved: "Approved", auto: "Allowed", block: "Blocked", failed: "Failed", approval: "Needs you", declined: "Declined",
  stock: "Low stock", proposed: "AI proposed", rules: "Rules", paypal: "PayPal", attack: "Attack test", resisted: "Resisted",
  flagged: "Flagged", slipped: "Gap", status: "Status",
};

/** Metric card: subdued box, neutral label, large value (Shopify Analytics style). */
export function Metric({ label, value, detail, href, badge, children }: {
  label: string; value: string; detail?: string; href?: string; badge?: { tone: Tone; label: string }; children?: React.ReactNode;
}) {
  return (
    <s-box padding="base" background="subdued" borderRadius="base">
      <s-stack gap="small-200">
        <s-stack direction="inline" gap="small-200" alignItems="center">
          <s-text tone="neutral">{label}</s-text>
          {badge && <s-badge tone={badge.tone}>{badge.label}</s-badge>}
        </s-stack>
        <s-heading>{value}</s-heading>
        {children}
        {detail && (href ? <s-link href={href}>{detail}</s-link> : <s-text tone="neutral">{detail}</s-text>)}
      </s-stack>
    </s-box>
  );
}

/** Responsive row of metric cards: 4 across, 2x2 when narrow. */
export function Metrics({ children }: { children: React.ReactNode }) {
  return (
    <s-query-container>
      {/* Responsive values are comma-separated, so the column lists must not contain commas themselves */}
      <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr 1fr, 1fr 1fr 1fr 1fr" gap="base">
        {children}
      </s-grid>
    </s-query-container>
  );
}

/** A label / value line. */
export function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <s-grid gridTemplateColumns="@container (inline-size <= 320px) 1fr, 160px 1fr" gap="small-200">
      <s-text tone="neutral">{label}</s-text>
      <s-box>{children}</s-box>
    </s-grid>
  );
}

/** Two equal columns, stacked when narrow. */
export function Columns({ children }: { children: React.ReactNode }) {
  return (
    <s-query-container>
      <s-grid gridTemplateColumns="@container (inline-size <= 640px) 1fr, 1fr 1fr" gap="large">{children}</s-grid>
    </s-query-container>
  );
}

/** Filter buttons above a table (the active one is outlined). */
export function Filters<T extends string>({ options, value, onChange }: { options: { id: T; label: string; count?: number }[]; value: T; onChange: (id: T) => void }) {
  return (
    <s-stack direction="inline" gap="small-200" alignItems="center">
      {options.map((o) => (
        <s-button key={o.id} variant={o.id === value ? "secondary" : "tertiary"} onClick={() => onChange(o.id)}>
          {o.count === undefined ? o.label : `${o.label} (${o.count})`}
        </s-button>
      ))}
    </s-stack>
  );
}
