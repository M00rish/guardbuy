// Formatting helpers shared by server code and the browser (no secrets, no database).

const money = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" });

/** 150000 -> "$1,500.00" */
export const usd = (cents: number) => money.format(cents / 100);
