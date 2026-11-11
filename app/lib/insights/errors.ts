export const ASSISTANT_ERRORS = {
  rate_limit: "Please wait a few seconds before asking another question.",
  service:
    "The AI service is temporarily unavailable. You can still ask a suggested question directly from your store data, or retry later.",
  unavailable:
    "The GuardBuy assistant is unavailable. Use the grid filters or try again later.",
  configuration:
    "AI-assisted questions are not configured for this store. Suggested questions still work from your store data.",
  credentials:
    "The AI service could not authenticate. Suggested questions still work from your store data.",
  quota:
    "The AI service has reached its usage limit. Try a suggested question or retry later.",
  model:
    "The AI model is unavailable. Try a suggested question for an answer from your store data.",
  response:
    "The AI provider could not return a valid data query. Try rephrasing your question.",
  timeout:
    "The AI service did not respond in time. Try a suggested question for an immediate answer from your store data, or retry later.",
} as const;
export class AssistantRequestError extends Error {
  constructor(readonly kind: keyof typeof ASSISTANT_ERRORS) {
    super(ASSISTANT_ERRORS[kind]);
  }
}
export function safeAssistantError(message: string) {
  return Object.values(ASSISTANT_ERRORS).some((value) => value === message)
    ? message
    : ASSISTANT_ERRORS.unavailable;
}
export type AssistantFailureKind = keyof typeof ASSISTANT_ERRORS;
export function assistantFailureKind(value: unknown): AssistantFailureKind {
  return typeof value === "string" && Object.hasOwn(ASSISTANT_ERRORS, value)
    ? (value as AssistantFailureKind)
    : "unavailable";
}
