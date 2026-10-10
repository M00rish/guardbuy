import type { LoaderFunctionArgs } from "react-router";

import { authenticate } from "../shopify.server";

// Storefront entry point for judges: https://<shop>/apps/guardbuy
// Shopify signs every proxied request; appProxy() rejects anything unsigned.
export const loader = async ({ request }: LoaderFunctionArgs) => {
  const { liquid } = await authenticate.public.appProxy(request);

  return liquid(
    `<div style="max-width: 640px; margin: 48px auto; font-family: system-ui, sans-serif;">
      <h1>GuardBuy</h1>
      <p>Hello from GuardBuy on {{ shop.name }}. The app proxy works.</p>
    </div>`,
  );
};
