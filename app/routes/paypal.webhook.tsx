import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { receivePayoutWebhook } from "../lib/paypal/webhook-handler.server";
export const action = ({ request }: ActionFunctionArgs) =>
  receivePayoutWebhook(request);
export const loader = ({ request }: LoaderFunctionArgs) =>
  receivePayoutWebhook(request);
