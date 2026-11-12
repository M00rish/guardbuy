
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import { authenticate } from "../shopify.server";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { useRouteError } from "react-router";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await authenticate.admin(request);

  return null;
};

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};

// Shopify's token-recovery response contains App Bridge HTML with status 200.
// It must be rendered by the SDK boundary rather than React Router's status page.
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
