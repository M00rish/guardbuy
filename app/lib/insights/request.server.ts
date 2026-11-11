import type { ActionFunctionArgs } from "react-router";
import { adminWithStaff } from "../merchant/staff.server";
import { planInsightView } from "./planner.server";
import { InsightPromptSchema } from "./plan";

// Session-scoped, bounded, in-memory cost limit; not an authorization boundary.
const requests = new Map<string, number>();
export const planInsightsRequest = async ({ request }: ActionFunctionArgs) => {
  const { session, actor } = await adminWithStaff(request);
  if (
    process.env.NODE_ENV === "production" &&
    (!process.env.AG_STUDIO_LICENSE_KEY || !process.env.AG_GRID_LICENSE_KEY)
  )
    return Response.json(
      { error: "Insights is not enabled yet." },
      { status: 503 },
    );
  if (!request.headers.get("content-type")?.startsWith("application/json"))
    return Response.json(
      { error: "Send a dashboard request as JSON." },
      { status: 415 },
    );
  // Read a bounded body before JSON parsing; never accept client tools or merchant data.
  const reader = request.body?.getReader();
  let text = "";
  if (reader) {
    const decoder = new TextDecoder();
    let bytes = 0;
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 4096) {
        await reader.cancel();
        return Response.json(
          { error: "Keep the request under 800 characters." },
          { status: 413 },
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
    text += decoder.decode();
  }
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return Response.json(
      { error: "Enter a valid dashboard request." },
      { status: 400 },
    );
  }
  const parsed = InsightPromptSchema.safeParse(input);
  if (!parsed.success)
    return Response.json(
      { error: "Enter a dashboard request of 1–800 characters." },
      { status: 400 },
    );
  const key = session.shop + ":" + actor,
    now = Date.now();
  for (const [k, at] of requests) if (now - at > 60_000) requests.delete(k);
  if (now - (requests.get(key) ?? 0) < 5_000)
    return Response.json(
      { error: "Wait a few seconds before asking again." },
      { status: 429 },
    );
  if (requests.size >= 1000 && !requests.has(key))
    return Response.json(
      { error: "The assistant is busy. Try again shortly." },
      { status: 429 },
    );
  requests.set(key, now);
  try {
    return Response.json(
      await planInsightView(parsed.data.prompt, request.signal),
    );
  } catch {
    return Response.json(
      {
        error:
          "Insights assistant is unavailable. Use the purchase filters or try again later.",
      },
      { status: 503 },
    );
  }
};
