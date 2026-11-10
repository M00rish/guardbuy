import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import {
  loadProducts,
  toggleProduct,
} from "../lib/merchant/products-page.server";
import {
  loadSuppliers,
  addSupplier,
} from "../lib/merchant/suppliers-page.server";
import { ProductsPanel } from "../components/products-panel";
import { SuppliersPanel } from "../components/suppliers-panel";

export const loader = async (args: LoaderFunctionArgs) => {
  const tab =
    new URL(args.request.url).searchParams.get("tab") === "suppliers"
      ? "suppliers"
      : "products";
  return {
    tab,
    products: tab === "products" ? await loadProducts(args) : null,
    suppliers: tab === "suppliers" ? await loadSuppliers(args) : null,
  };
};
export const action = async (args: ActionFunctionArgs) => {
  const intent = (await args.request.clone().formData()).get("intent");
  return intent === "add-supplier" ? addSupplier(args) : toggleProduct(args);
};
export default function ProductsAndSuppliers() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="Products & Suppliers" inlineSize="large">
      <s-stack gap="base">
        <s-section>
          <s-stack direction="inline" gap="base">
            <s-button
              href="/app/products"
              variant={data.tab === "products" ? "secondary" : "tertiary"}
            >
              Products
            </s-button>
            <s-button
              href="/app/products?tab=suppliers"
              variant={data.tab === "suppliers" ? "secondary" : "tertiary"}
            >
              Suppliers
            </s-button>
          </s-stack>
        </s-section>
        {data.products && <ProductsPanel data={data.products} />}
        {data.suppliers && <SuppliersPanel data={data.suppliers} />}
      </s-stack>
    </s-page>
  );
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
export { PageError as ErrorBoundary } from "../components/page-error";
