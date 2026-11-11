export const ASSISTANT_ERRORS = {
  rate_limit: "Please wait a few seconds before asking another question.",
  unavailable:
    "The GuardBuy assistant is unavailable. Use the grid filters or try again later.",
  configuration:
    "The AI provider is not configured for the selected models. Check the Render AI settings.",
  credentials:
    "The AI provider rejected its credentials. Check the configured API key in Render.",
  quota:
    "The AI provider's quota or rate limit was reached. Try again later or check the provider account.",
  model:
    "The configured AI model is unavailable. Check the model names in Render.",
  response:
    "The AI provider could not return a valid data query. Try rephrasing your question.",
  timeout:
    "The question took too long. Try again or ask a more specific question.",
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
