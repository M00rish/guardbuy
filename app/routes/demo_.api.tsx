import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";

import { requirePublicDemo } from "../lib/demo/dashboard.server";
import { judgeApiGet, judgeApiPost } from "../lib/judge/console-api.server";

// JSON for the public judge console. Only the demo shop's isolated `#judge-<id>` sandboxes exist here.
const demoShop = () => process.env.GUARDBUY_DEMO_STORE ?? "guardbuy-demo.myshopify.com";

export const loader = async ({ request }: LoaderFunctionArgs) => {
  requirePublicDemo(demoShop());
  return judgeApiGet(demoShop(), new URL(request.url).searchParams.get("j") ?? "");
};

export const action = async ({ request }: ActionFunctionArgs) => {
  requirePublicDemo(demoShop());
  return judgeApiPost(demoShop(), await request.formData());
};
