import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { redirect } from "react-router";
import { privateAdmin } from "../lib/merchant/staff.server";
import { legacyDestination } from "../lib/merchant/navigation";
export { addSupplier as action } from "../lib/merchant/suppliers-page.server";
export const loader = async ({ request }: LoaderFunctionArgs) => {
  await privateAdmin(request);
  return redirect(
    legacyDestination(request.url, "/app/products?tab=suppliers"),
  );
};

export const headers: HeadersFunction = (args) => boundary.headers(args);
export { PageError as ErrorBoundary } from "../components/page-error";
