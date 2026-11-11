import { useEffect, useState, useRef } from "react";
import type {
  AgAiHarness,
  AgAiChatSession,
  AgAiChatMessage,
  AgAiRunStatus,
} from "ag-studio";
import { safeAssistantError } from "../lib/insights/agent";
import styles from "./home-workspace.module.css";

/** Thin transcript UI over AG Studio's harness. The agent still owns its one
 * validated view-selection tool; this panel adds no business command paths. */
export function WorkspaceAssistant({
  harness,
  onClose,
  demo = false,
}: {
  harness: AgAiHarness;
  onClose: () => void;
  demo?: boolean;
}) {
  const [session, setSession] = useState<AgAiChatSession>();
  const [messages, setMessages] = useState<readonly AgAiChatMessage[]>([]);
  const [status, setStatus] = useState<AgAiRunStatus>("idle");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const transcriptRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (status !== "running") {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [status]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages, status]);
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
      aria-label="Read-only GuardBuy assistant"
    >
      <div className={styles.detailHeading}>
        <div>
          <strong>Ask GuardBuy</strong>
          <small className={styles.assistantScope}>
            {demo ? "Fictional demo" : "Live snapshot"} · read only
          </small>
        </div>
        <button type="button" onClick={onClose} aria-label="Close assistant">
          Close
        </button>
      </div>
      <p>
        Ask about products, stock, purchases, suppliers or budgets. I’ll show
        the supporting data in the grid.
      </p>
      <div className={styles.transcript} ref={transcriptRef} aria-live="polite">
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
                <small className={styles.toolStatus} key={index}>
                  {part.toolCall.status === "complete"
                    ? "Related data shown in grid"
                    : part.toolCall.status === "cancelled"
                      ? "Stopped"
                      : "Updating the grid…"}
                </small>
              ) : part.type === "error" ? (
                <p key={index}>{safeAssistantError(part.message)}</p>
              ) : null,
            )}
          </div>
        ))}
        {!messages.length && (
          <p>
            Try “Rank products by automatic restock count”, “Which products may
            run out soon?” or “Why was purchase #123 blocked?”
          </p>
        )}
        {error && (
          <p role="alert">
            The assistant is unavailable. You can still use all grid controls.
          </p>
        )}
      </div>
      {status === "running" && (
        <p className={styles.loadingStatus} role="status">
          {elapsed < 7
            ? "Reading your question…"
            : "Still working on your question. You can stop at any time."}
        </p>
      )}
      <form
        className={styles.assistantComposer}
        onSubmit={(event) => {
          event.preventDefault();
          const text = prompt.trim();
          if (session && text && status !== "running") {
            session.sendMessage(text);
            setPrompt("");
          }
        }}
      >
        <label htmlFor="workspace-ai-request">Your question</label>
        <textarea
          id="workspace-ai-request"
          value={prompt}
          onChange={(event) => setPrompt(event.target.value)}
          maxLength={800}
          rows={3}
          required
          placeholder="Ask a question about GuardBuy…"
          onKeyDown={(event) => {
            if (
              event.key === "Enter" &&
              !event.shiftKey &&
              !event.nativeEvent.isComposing
            ) {
              event.preventDefault();
              if (status !== "running")
                event.currentTarget.form?.requestSubmit();
            }
          }}
        />
        <div className={styles.composerActions}>
          <button
            type="submit"
            disabled={!session || status === "running" || !prompt.trim()}
          >
            {status === "running" ? "Working…" : "Ask GuardBuy"}
          </button>
          {status === "running" && (
            <button type="button" onClick={() => session?.cancel()}>
              Stop
            </button>
          )}
        </div>
        <small className={styles.assistantPrivacy}>
          Your question is sent to the AI provider. Keep secrets and personal
          information out.
        </small>
      </form>
    </aside>
  );
}
