import { useEffect, useState } from "react";
import type {
  AgAiHarness,
  AgAiChatSession,
  AgAiChatMessage,
  AgAiRunStatus,
} from "ag-studio";
import styles from "./home-workspace.module.css";

/** Thin transcript UI over AG Studio's harness. The agent still owns its one
 * validated view-selection tool; this panel adds no business command paths. */
export function WorkspaceAssistant({
  harness,
  onClose,
}: {
  harness: AgAiHarness;
  onClose: () => void;
}) {
  const [session, setSession] = useState<AgAiChatSession>();
  const [messages, setMessages] = useState<readonly AgAiChatMessage[]>([]);
  const [status, setStatus] = useState<AgAiRunStatus>("idle");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState(false);
  useEffect(() => {
    let active = true;
    let current: AgAiChatSession | undefined;
    const update = () => {
      if (active && current) {
        setMessages(current.messages);
        setStatus(current.status);
      }
    };
    harness
      .createThread({ agentId: "guardbuy-insights" })
      .then((thread) => {
        if (!active) {
          thread.close();
          return;
        }
        current = thread;
        thread.addEventListener("changed", update);
        setSession(thread);
        update();
      })
      .catch(() => {
        if (active) setError(true);
      });
    return () => {
      active = false;
      current?.cancel();
      current?.removeEventListener("changed", update);
      current?.close();
    };
  }, [harness]);
  return (
    <aside
      className={styles.assistant}
      aria-label="Read-only purchase assistant"
    >
      <div className={styles.detailHeading}>
        <strong>Ask AI · purchases</strong>
        <button type="button" onClick={onClose} aria-label="Close assistant">
          Close
        </button>
      </div>
      <p>
        Explore purchases and compare suppliers. Your request goes to the
        configured AI provider; keep secrets and personal information out.
      </p>
      <div className={styles.transcript} aria-live="polite">
        {messages.map((message) => (
          <div
            key={message.id}
            className={styles.message}
            data-role={message.role}
          >
            <strong>{message.role === "user" ? "You" : "GuardBuy"}</strong>
            {message.parts.map((part, index) =>
              part.type === "text" ? (
                <p key={index}>{part.text}</p>
              ) : part.type === "tool_call" ? (
                <small key={index}>Purchase view: {part.toolCall.status}</small>
              ) : part.type === "error" ? (
                <p key={index}>
                  The assistant is unavailable. Use the grid filters or try
                  again later.
                </p>
              ) : null,
            )}
          </div>
        ))}
        {!messages.length && (
          <p>
            Try “Compare suppliers by settled spend” or “Why were purchases
            blocked?”
          </p>
        )}
        {error && (
          <p role="alert">
            The assistant is unavailable. You can still use all grid controls.
          </p>
        )}
      </div>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const text = prompt.trim();
          if (session && text && status !== "running") {
            session.sendMessage(text);
            setPrompt("");
          }
        }}
      >
        <label htmlFor="workspace-ai-request">Your request</label>
        <textarea
          id="workspace-ai-request"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          maxLength={800}
          rows={3}
          required
        />
        <button
          type="submit"
          disabled={!session || status === "running" || !prompt.trim()}
        >
          {status === "running" ? "Working…" : "Ask"}
        </button>
        {status === "running" && (
          <button type="button" onClick={() => session?.cancel()}>
            Stop
          </button>
        )}
      </form>
    </aside>
  );
}
