// Formatting helpers shared by server code and the browser (no secrets, no database).

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
