/** A direct browser entry has no Shopify context to authenticate or bounce back into. */
export function needsShopifyEntry(request: Request) {
  if (request.method !== "GET" || request.headers.has("Authorization"))
    return false;
  // Shopify's iframe/bootstrap and client data requests still belong to the SDK.
  const destination = request.headers.get("Sec-Fetch-Dest");
  if (destination && destination !== "document") return false;
  const url = new URL(request.url);
  return (
    (url.pathname === "/app" || url.pathname.startsWith("/app/")) &&
    !["shop", "host", "embedded", "id_token"].some((key) =>
      url.searchParams.has(key),
    )
  );
}
