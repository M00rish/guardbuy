import type { ActionFunctionArgs } from "react-router";
import { Form, useActionData } from "react-router";
import { login } from "../shopify.server";
import { loginErrorMessage } from "./_index/error.server";
import styles from "./_index/styles.module.css";

export const action = async ({ request }: ActionFunctionArgs) => ({
  errors: loginErrorMessage(await login(request)),
});
export const meta = () => [{ title: "Open GuardBuy in Shopify" }];

export default function ShopifyEntry() {
  const result = useActionData<typeof action>();
  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <h1 className={styles.heading}>Open GuardBuy in Shopify</h1>
        <p className={styles.lede}>
          GuardBuy runs inside Shopify Admin. Open your store’s Apps menu and
          select GuardBuy, or enter your store address below to continue through
          Shopify.
        </p>
        <Form method="post" className={styles.install}>
          <label className={styles.label} htmlFor="shop">
            Shopify store address
          </label>
          <div className={styles.row}>
            <input
              className={styles.input}
              id="shop"
              name="shop"
              type="text"
              required
              placeholder="your-store.myshopify.com"
              autoComplete="off"
              aria-describedby={result?.errors.shop ? "shop-error" : undefined}
            />
            <button className={styles.button} type="submit">
              Continue in Shopify
            </button>
          </div>
          {result?.errors.shop && (
            <p id="shop-error" className={styles.error}>
              {result.errors.shop}
            </p>
          )}
        </Form>
        <p>
          <a href="/">About GuardBuy</a> · <a href="/privacy">Privacy policy</a>
        </p>
      </div>
    </main>
  );
}
