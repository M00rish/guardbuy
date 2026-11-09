/** Keep Shopify embedding parameters and purchase IDs on historical deep links. */
export function legacyDestination(requestUrl: string, destination: string) {
  const old = new URL(requestUrl);
  const target = new URL(destination, old.origin);
  for (const [key, value] of old.searchParams)
    if (!target.searchParams.has(key)) target.searchParams.append(key, value);
  return target.pathname + target.search;
}
