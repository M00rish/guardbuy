import { PayPalAgentToolkit } from "@paypal/agent-toolkit/ai-sdk";

import { merchantCredentials } from "./client.server";

// PayPal's Agent Toolkit, called directly from server code (deterministic, no LLM in the loop).
// The toolkit targets an older AI SDK, so we use its tools' execute functions rather than its
// AI SDK integration. Results come back as JSON strings or objects; normalize to objects.

type ToolkitTool = { execute: (args: unknown, opts: unknown) => Promise<unknown> };
let tools: Record<string, ToolkitTool> | null = null;

function toolkit(): Record<string, ToolkitTool> {
  if (!tools) {
    const { clientId, clientSecret } = merchantCredentials();
    tools = new PayPalAgentToolkit({
      clientId,
      clientSecret,
      // Least privilege: only the two read-only tools GuardBuy calls. No refunds, payments or invoices.
      configuration: { actions: { orders: { get: true }, transactions: { list: true } }, context: { sandbox: true } },
    }).getTools() as unknown as Record<string, ToolkitTool>;
  }
  return tools;
}

export async function runPayPalTool<T = any>(name: string, args: Record<string, unknown>): Promise<T> {
  const tool = toolkit()[name];
  if (!tool) throw new Error(`Unknown PayPal toolkit tool: ${name}`);
  const raw = await tool.execute(args, { toolCallId: `guardbuy-${name}`, messages: [] });
  const value = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (value && typeof value === "object" && ("error" in value || (value as any).ok === false)) {
    throw new Error(`PayPal toolkit ${name} failed: ${JSON.stringify(value).slice(0, 300)}`);
  }
  return value as T;
}
