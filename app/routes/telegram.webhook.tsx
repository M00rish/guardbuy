import type { ActionFunctionArgs } from "react-router";
import { telegramWebhook } from "../lib/alerts/service.server";
export const action = ({ request }: ActionFunctionArgs) =>
  telegramWebhook(request);
