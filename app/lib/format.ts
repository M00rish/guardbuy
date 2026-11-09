// Formatting helpers shared by server code and the browser (no secrets, no database).

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 150000 -> "$1,500.00" */
export const usd = (cents: number) => money.format(cents / 100);

/** Stable server/browser formatting with an explicit timezone. */
export function readableTime(iso: string) {
  return new Intl.DateTimeFormat("en-GB", { dateStyle: "medium", timeStyle: "medium", timeZone: "UTC" }).format(new Date(iso)) + " UTC";
}
