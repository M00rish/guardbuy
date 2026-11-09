import type {
  ActionFunctionArgs,
  HeadersFunction,
  LoaderFunctionArgs,
} from "react-router";
import { useLoaderData } from "react-router";
import { boundary } from "@shopify/shopify-app-react-router/server";
import { loadRules, signRules } from "../lib/merchant/rules-editor.server";
import {
  loadApprovals,
  approvalAction,
} from "../lib/merchant/approval-page.server";
import { RulesEditor } from "../components/rules-editor";
import { ApprovalsPanel } from "../components/approval-page";

export const loader = async (args: LoaderFunctionArgs) => {
  const tab =
    new URL(args.request.url).searchParams.get("tab") === "approvals"
      ? "approvals"
      : "rules";
  // Editing rules must not invoke the approval page's existing Order capture sweep.
  return {
    tab,
    rules: tab === "rules" ? await loadRules(args) : null,
    approvals: tab === "approvals" ? await loadApprovals(args) : null,
  };
};
export const action = async (args: ActionFunctionArgs) => {
  const intent = (await args.request.clone().formData()).get("intent");
  // Accept old Rules POSTs without an intent, too; payment intents remain explicit.
  return intent === "sign-rules" || intent === null
    ? signRules(args)
    : approvalAction(args);
};
export default function RulesAndApprovals() {
  const data = useLoaderData<typeof loader>();
  return (
    <s-page heading="Rules & Approvals" inlineSize="large">
      <s-stack gap="base">
        <s-section>
          <s-stack direction="inline" gap="base">
            <s-button
              href="/app/rules?tab=approvals"
              variant={data.tab === "approvals" ? "secondary" : "tertiary"}
            >
              Approvals
            </s-button>
            <s-button
              href="/app/rules?tab=rules"
              variant={data.tab === "rules" ? "secondary" : "tertiary"}
            >
              Rules
            </s-button>
          </s-stack>
        </s-section>
        {data.approvals && <ApprovalsPanel data={data.approvals} />}
        {data.rules && <RulesEditor data={data.rules} />}
      </s-stack>
    </s-page>
  );
}
export const headers: HeadersFunction = (args) => boundary.headers(args);
export { PageError as ErrorBoundary } from "../components/page-error";
