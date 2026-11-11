import {
  redirect,
  type LoaderFunctionArgs,
  type HeadersFunction,
} from "react-router";
import { adminWithStaff } from "../lib/merchant/staff.server";
import { boundary } from "@shopify/shopify-app-react-router/server";

// Keep old bookmarks authenticated; the purchasing dashboard now lives on Home.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await adminWithStaff(request);
  const source = new URL(request.url);
  const target = new URL("/app", source);
  for (const key of ["host", "shop", "embedded"]) {
    const value = source.searchParams.get(key);
    if (value) target.searchParams.set(key, value);
  }
  return redirect(target.pathname + target.search, {
    headers: { "Cache-Control": "private, no-store" },
  });
};
// Compatibility for an already-open older client; new clients use the JSON resource.
export { planInsightsRequest as action } from "../lib/insights/request.server";
export const headers: HeadersFunction = (args) => {
  const headers = new Headers(boundary.headers(args));
  headers.set("Cache-Control", "private, no-store");
  return headers;
};
