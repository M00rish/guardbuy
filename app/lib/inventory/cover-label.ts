/** Null cover may mean no net demand, rather than a failed inventory request. */
export function coverLabel(cover: number | null | undefined, perDay?: number) {
  return cover == null || !Number.isFinite(cover)
    ? perDay === 0
      ? "No recent sales"
      : "Unavailable"
    : String(cover);
}
export function coverExplanation(
  cover: number | null | undefined,
  perDay?: number,
) {
  return (cover == null || !Number.isFinite(cover)) && perDay === 0
    ? "No positive net sales recorded in the last 30 days. Stock cover cannot be estimated; enabling auto restock does not force a purchase."
    : undefined;
}
