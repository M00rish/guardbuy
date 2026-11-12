import { COPY } from "../lib/wording";
import { isRouteErrorResponse, useRouteError } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";

// Error page for admin routes. Shopify's auth responses are handled by the SDK boundary
// here so a render-time rethrow cannot escape into the generic status page. Anything else, usually Shopify's API or PayPal briefly not
// answering, gets a plain page with a retry instead of a stack trace. The nav stays usable.

export function PageError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return boundary.error(error);
  if (typeof console !== "undefined") console.error(error);
  return (
    <s-page heading="Something didn't load" inlineSize="large">
      <s-section>
        <s-stack gap="base">
          <s-banner tone="warning" heading="Page unavailable">
            {COPY.loadError}
          </s-banner>
          <s-stack direction="inline" gap="base">
            <s-button variant="primary" onClick={() => window.location.reload()}>Try again</s-button>
            <s-button href="/app">Go to Home</s-button>
          </s-stack>
        </s-stack>
      </s-section>
    </s-page>
  );
}
