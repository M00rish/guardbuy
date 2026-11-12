import { useLiveUpdates } from "../components/live-updates";
import { LoadingProgress } from "../components/loading-state";
import { useEffect } from "react";
import type { HeadersFunction, LoaderFunctionArgs } from "react-router";
import {
  Outlet,
  useLoaderData,
  useNavigation,
  useRouteError,
  useFetchers,
  useRevalidator,
} from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { useAppBridge } from "@shopify/app-bridge-react";

import { privateAdmin } from "../lib/merchant/staff.server";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  await privateAdmin(request);

  // eslint-disable-next-line no-undef
  return { apiKey: process.env.SHOPIFY_API_KEY || "", gridLicenseKey: process.env.AG_GRID_LICENSE_KEY ?? "" };
};

/** Shows Shopify's loading bar at the top of the admin while a page or action is loading. */
function LoadingBar({ background }: { background: boolean }) {
  const navigation = useNavigation();
  const shopify = useAppBridge();
  const fetchers = useFetchers();
  const revalidator = useRevalidator();
  const loading =
    navigation.state !== "idle" ||
    (!background && revalidator.state !== "idle") ||
    fetchers.some((f) => f.state !== "idle");
  useEffect(() => {
    shopify.loading(loading);
  }, [loading, shopify]);
  return loading ? <LoadingProgress /> : null;
}

export default function App() {
  const { apiKey } = useLoaderData<typeof loader>();
  const background = useLiveUpdates();

  return (
    <AppProvider apiKey={apiKey}>
      <s-app-nav>
        <s-link href="/app">Home</s-link>
        <s-link href="/app/products">Products & Suppliers</s-link>
        <s-link href="/app/rules">Rules &amp; Approvals</s-link>
        <s-link href="/app/deliveries">Deliveries</s-link>
        <s-link href="/app/activity">Activity</s-link>
        <s-link href="/app/alerts">Alerts</s-link>
      </s-app-nav>
      <LoadingBar background={background} />
      <Outlet />
    </AppProvider>
  );
}

// Shopify needs React Router to catch some thrown responses, so that their headers are included in the response.
// Other errors are caught by each page's own ErrorBoundary (components/page-error.tsx).
export function ErrorBoundary() {
  return boundary.error(useRouteError());
}

export const headers: HeadersFunction = (headersArgs) => {
  return boundary.headers(headersArgs);
};
