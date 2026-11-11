import { ViewTabs } from "../components/view-tabs";
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
        <ViewTabs label="Page sections" value={data.tab} options={[{id:"products",label:"Products",href:"/app/products"},{id:"suppliers",label:"Suppliers",href:"/app/products?tab=suppliers"}]} />
        {data.products && <ProductsPanel data={data.products} />}
        {data.suppliers && <SuppliersPanel data={data.suppliers} />}
      </s-stack>
    </s-page>
  );
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
export { PageError as ErrorBoundary } from "../components/page-error";
