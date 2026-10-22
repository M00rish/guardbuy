import { isRouteErrorResponse, useRouteError } from "react-router";

// Error page for admin routes. Shopify's auth responses (thrown Responses) are re-thrown so the
// app layout's boundary handles them; anything else, usually Shopify's API or PayPal briefly not
// answering, gets a plain page with a retry instead of a stack trace. The nav stays usable.

export function PageError() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) throw error;
  if (typeof console !== "undefined") console.error(error);
  return (
    <s-page heading="Something didn't load" inlineSize="large">
      <s-section>
        <s-stack gap="base">
          <s-banner tone="warning" heading="Shopify or PayPal didn't answer in time">
            This is usually brief. Nothing was bought or paid, and the agent keeps following your rules.
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
