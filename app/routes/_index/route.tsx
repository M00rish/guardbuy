import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { redirect, Form, useActionData, useLoaderData } from "react-router";

import { login } from "../../shopify.server";
import { loginErrorMessage } from "./error.server";

import styles from "./styles.module.css";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  const url = new URL(request.url);

  if (url.searchParams.get("shop")) {
    throw redirect(`/app?${url.searchParams.toString()}`);
  }

  return { showForm: Boolean(login) };
};

export const action = async ({ request }: ActionFunctionArgs) => {
  const errors = loginErrorMessage(await login(request));

  return { errors };
};

// Public landing page at the app's root URL (outside the Shopify admin). Inside the admin, Shopify
// opens /app with the shop in the URL, and the loader above redirects there.
const DEMO_STORE = process.env.GUARDBUY_DEMO_STORE ?? "guardbuy-demo.myshopify.com";

export const meta = () => [
  { title: "GuardBuy · AI restocking that can only spend inside your rules" },
  { name: "description", content: "GuardBuy restocks your Shopify store with AI, pays suppliers through PayPal, and every purchase stays inside rules you sign, on a log anyone can verify." },
];

export default function App() {
  const { showForm } = useLoaderData<typeof loader>();
  const actionData = useActionData<typeof action>();
  const errors = actionData?.errors;

  return (
    <main className={styles.page}>
      <div className={styles.wrap}>
        <p className={styles.eyebrow}>GuardBuy · for Shopify · paid through PayPal</p>
        <h1 className={styles.heading}>AI restocking that can only spend inside your rules</h1>
        <p className={styles.lede}>
          You choose what to restock and from whom. The agent decides when and how much. Your rules decide whether money
          moves, and every step lands on a log anyone can verify.
        </p>

        <div className={styles.actions}>
          <a className={styles.primary} href={`https://${DEMO_STORE}/apps/guardbuy`}>Try the live demo</a>
          <a className={styles.secondary} href="/verify">Verify a payment</a>
          <a className={styles.secondary} href="https://github.com/M00rish/guardbuy">How it works</a>
        </div>

        <ul className={styles.features}>
          <li>
            <h2>The AI proposes, your rules decide</h2>
            <p>Spending caps, approved suppliers, price and quantity limits, a cash floor. A deterministic engine checks every purchase; the AI can't change the rules or pick who gets paid.</p>
          </li>
          <li className={styles.money}>
            <h2>PayPal pays your suppliers</h2>
            <p>Small restocks pay automatically. Bigger ones wait for you, in GuardBuy or inside PayPal with buyer protection.</p>
          </li>
          <li>
            <h2>A log you can verify</h2>
            <p>Every proposal, decision and payment is hash-chained. Change or delete any past entry and verification fails.</p>
          </li>
        </ul>

        {showForm && (
          <Form className={styles.install} method="post">
            <label className={styles.label} htmlFor="shop">Install on your store</label>
            <div className={styles.row}>
              <input className={styles.input} id="shop" type="text" name="shop" placeholder="your-store.myshopify.com" autoComplete="off" />
              <button className={styles.button} type="submit">Continue</button>
            </div>
            {errors?.shop && <p className={styles.error}>{errors.shop}</p>}
          </Form>
        )}
      </div>
    </main>
  );
}
