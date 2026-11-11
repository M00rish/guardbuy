import { randomUUID } from "node:crypto";
import { ASSISTANT_ERRORS, type AssistantFailureKind } from "./errors";

export type PlannerAttempt = {
  provider: "google" | "openrouter";
  code: AssistantFailureKind;
  status?: number;
};
export class PlannerFailure extends Error {
  constructor(
    readonly kind: AssistantFailureKind,
    readonly requestId = randomUUID(),
    readonly attempts: PlannerAttempt[] = [],
  ) {
    super(ASSISTANT_ERRORS[kind]);
  }
}

/** Only fixed categories/status codes are retained; never log provider bodies or prompts. */
export function classifyPlannerFailure(error: unknown): AssistantFailureKind {
  if (!error || typeof error !== "object") return "unavailable";
  const e = error as { name?: unknown; statusCode?: unknown; cause?: unknown };
  if (e.statusCode === 401 || e.statusCode === 403) return "credentials";
  if (e.statusCode === 429 || e.statusCode === 402) return "quota";
  if ([500, 502, 503, 504].includes(Number(e.statusCode))) return "service";
  if (e.statusCode === 404 || e.statusCode === 410) return "model";
  if (e.name === "TimeoutError" || e.name === "AbortError") return "timeout";
  if (
    [
      "AI_NoObjectGeneratedError",
      "AI_NoOutputGeneratedError",
      "AI_TypeValidationError",
      "ZodError",
    ].includes(String(e.name))
  )
    return "response";
  // SDK validation errors may wrap the original provider error.
  if (e.cause && e.cause !== error) {
    const cause = e.cause as { statusCode?: unknown; name?: unknown };
    if (typeof cause.statusCode === "number")
      return classifyPlannerFailure({ statusCode: cause.statusCode });
  }
  return "unavailable";
}

export function plannerFailureResponse(error: unknown) {
  const failure =
    error instanceof PlannerFailure ? error : new PlannerFailure("unavailable");
  return {
    error: failure.message,
    code: failure.kind,
    requestId: failure.requestId,
    attempts: failure.attempts,
  };
}
