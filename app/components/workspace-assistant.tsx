import { useEffect, useState, useRef, useMemo } from "react";
import type {
  AgAiHarness,
  AgAiChatSession,
  AgAiChatMessage,
  AgAiRunStatus,
} from "ag-studio";
import { safeAssistantError } from "../lib/insights/errors";
import { readableTime } from "../lib/format";
import styles from "./workspace-assistant.module.css";
const starters = [
  {
    title: "Supplier directory",
    question: "How many suppliers do I have?",
    description: "Count and list your suppliers",
  },
  {
    title: "Budget headroom",
    question: "What is my remaining budget?",
    description: "See what is available to spend",
  },
  {
    title: "Stock risk",
    question: "Which products need restocking?",
    description: "Find products below your threshold",
  },
  {
    title: "Open purchases",
    question: "What needs attention?",
    description: "Review outstanding work",
  },
];
function Icon({
  name,
}: {
  name:
    | "spark"
    | "close"
    | "expand"
    | "collapse"
    | "new"
    | "send"
    | "stop"
    | "retry"
    | "grid";
}) {
  const paths = {
    spark: "m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z",
    close: "m6 6 12 12M18 6 6 18",
    expand: "M9 4H4v5m11-5h5v5M4 15v5h5m11-5v5h-5",
    collapse: "M4 9h5V4m6 0v5h5M9 20v-5H4m16 0h-5v5",
    new: "M12 5H5v14h14v-7M15 3v6m-3-3h6",
    send: "M12 20V4m-6 6 6-6 6 6",
    stop: "M6 6h12v12H6Z",
    retry: "M4 10a8 8 0 1 1 1 8M4 4v6h6",
    grid: "M4 4h16v16H4ZM4 10h16M10 4v16",
  };
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={paths[name]} />
    </svg>
  );
}
/** Modeless grid companion; closing preserves the read-only conversation. */
export function WorkspaceAssistant({
  harness,
  onClose,
  demo = false,
  open = true,
  checkedAt,
}: {
  harness: AgAiHarness;
  onClose: () => void;
  demo?: boolean;
  open?: boolean;
  checkedAt?: string;
}) {
  const [session, setSession] = useState<AgAiChatSession>();
  const [messages, setMessages] = useState<readonly AgAiChatMessage[]>([]);
  const [status, setStatus] = useState<AgAiRunStatus>("idle");
  const [prompt, setPrompt] = useState("");
  const [error, setError] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [generation, setGeneration] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const transcriptRef = useRef<HTMLDivElement>(null),
    inputRef = useRef<HTMLTextAreaElement>(null);
  const returnFocus = useRef<HTMLElement>();
  const running = status === "running";
  const displayMessages = useMemo(() => {
    const grouped: AgAiChatMessage[] = [];
    for (const message of messages) {
      if (message.role === "system") continue;
      const previous = grouped.at(-1);
      if (previous?.role === "assistant" && message.role === "assistant")
        grouped[grouped.length - 1] = {
          ...previous,
          parts: [...previous.parts, ...message.parts],
        };
      else grouped.push(message);
    }
    return grouped;
  }, [messages]);
  const lastQuestion = [...messages]
    .reverse()
    .find((m) => m.role === "user")
    ?.parts.filter((p) => p.type === "text")
    .map((p) => p.text)
    .join("\n");
  useEffect(() => {
    if (!open) {
      returnFocus.current?.focus();
      return;
    }
    const active = document.activeElement;
    if (
      active instanceof HTMLElement &&
      !active.closest('[aria-label="Read-only GuardBuy assistant"]')
    )
      returnFocus.current = active;
    inputRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const escape = (event: KeyboardEvent) => {
      if (
        event.key === "Escape" &&
        event.target instanceof Element &&
        event.target.closest('[aria-label="Read-only GuardBuy assistant"]')
      ) {
        event.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", escape);
    return () => document.removeEventListener("keydown", escape);
  }, [open, onClose]);
  useEffect(() => {
    if (!running) {
      setElapsed(0);
      return;
    }
    const started = Date.now();
    const timer = setInterval(
      () => setElapsed(Math.floor((Date.now() - started) / 1000)),
      1000,
    );
    return () => clearInterval(timer);
  }, [running]);
  useEffect(() => {
    const transcript = transcriptRef.current;
    if (transcript) transcript.scrollTop = transcript.scrollHeight;
  }, [messages, status, open]);
  useEffect(() => {
    let active = true,
      current: AgAiChatSession | undefined;
    setMessages([]);
    setSession(undefined);
    setError(false);
    setStatus("idle");
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
  }, [harness, generation]);
  const send = (text: string) => {
    const question = text.trim();
    if (!session || !question || running) return;
    try {
      session.sendMessage(question);
      setPrompt("");
      setError(false);
    } catch {
      setError(true);
    }
    inputRef.current?.focus();
  };
  const inspect = () => {
    onClose();
    requestAnimationFrame(() =>
      document
        .getElementById("home-grid-panel")
        ?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  };
  return (
    <div
      id="guardbuy-assistant-panel"
      role="dialog"
      aria-modal={false}
      tabIndex={-1}
      hidden={!open}
      className={`${styles.assistant} ${expanded ? styles.expanded : ""}`}
      aria-label="Read-only GuardBuy assistant"
    >
      <header className={styles.header}>
        <span className={styles.mark}>
          <Icon name="spark" />
        </span>
        <div className={styles.heading}>
          <h2>Ask GuardBuy</h2>
          <span>Explore your store data</span>
        </div>
        <div className={styles.headerActions}>
          <button
            type="button"
            aria-label="New conversation"
            title="New conversation"
            onClick={() => {
              setGeneration((g) => g + 1);
              setPrompt("");
              inputRef.current?.focus();
            }}
          >
            <Icon name="new" />
          </button>
          <button
            type="button"
            className={styles.expandButton}
            aria-label={
              expanded ? "Reduce assistant width" : "Expand assistant"
            }
            title={expanded ? "Reduce width" : "Expand"}
            aria-pressed={expanded}
            onClick={() => setExpanded((v) => !v)}
          >
            <Icon name={expanded ? "collapse" : "expand"} />
          </button>
          <button
            type="button"
            aria-label="Close assistant"
            title="Close"
            onClick={onClose}
          >
            <Icon name="close" />
          </button>
        </div>
      </header>
      <div className={styles.context}>
        <span>
          <i className={demo ? styles.demoDot : styles.liveDot} />
          {demo ? "Fictional demo" : "Live snapshot"}
        </span>
        <span className={styles.readonly}>Read only</span>
      </div>
      <div
        className={styles.transcript}
        ref={transcriptRef}
        role="log"
        aria-label="Conversation"
        aria-live="polite"
        aria-relevant="additions text"
        aria-busy={running}
      >
        {!messages.length && !error && (
          <div className={styles.welcome}>
            <span className={styles.welcomeIcon}>
              <Icon name="grid" />
            </span>
            <h3>What would you like to know?</h3>
            <p>
              Ask a question about your store. I’ll show the answer and the
              records behind it.
            </p>
            <div className={styles.starters}>
              {starters.map((s) => (
                <button
                  type="button"
                  key={s.title}
                  disabled={!session || running}
                  onClick={() => send(s.question)}
                >
                  <strong>{s.title}</strong>
                  <span>{s.description}</span>
                </button>
              ))}
            </div>
            <small>
              These questions work directly from your store snapshot.
            </small>
          </div>
        )}
        {displayMessages.map((message, messageIndex) => {
          const failed = message.parts.some((p) => p.type === "error");
          const completed = message.parts.some(
            (p) => p.type === "tool_call" && p.toolCall.status === "complete",
          );
          return (
            <article
              key={message.id}
              className={`${styles.message} ${failed ? styles.failed : ""}`}
              data-role={message.role}
            >
              <div className={styles.messageHeading}>
                <span>{message.role === "user" ? "You" : "GuardBuy"}</span>
                {message.role !== "user" && (
                  <small>
                    {failed ? "Couldn’t complete" : "Store snapshot"}
                  </small>
                )}
              </div>
              {message.parts.map((part, index) =>
                part.type === "text" ? (
                  <p key={index}>{part.text}</p>
                ) : part.type === "error" ? (
                  <p key={index}>{safeAssistantError(part.message)}</p>
                ) : part.type === "tool_call" &&
                  !["complete", "error"].includes(part.toolCall.status) ? (
                  <small key={index} className={styles.toolStatus}>
                    {part.toolCall.status === "cancelled"
                      ? "Stopped"
                      : "Finding supporting records…"}
                  </small>
                ) : null,
              )}
              {completed &&
                !failed &&
                messageIndex === displayMessages.length - 1 && (
                  <button
                    type="button"
                    className={styles.resultLink}
                    onClick={inspect}
                  >
                    <Icon name="grid" /> View grid
                  </button>
                )}
              {failed && lastQuestion && (
                <div className={styles.recovery}>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => send(lastQuestion)}
                  >
                    <Icon name="retry" /> Try again
                  </button>
                  <button
                    type="button"
                    disabled={running}
                    onClick={() => send(starters[0].question)}
                  >
                    Show supplier count
                  </button>
                </div>
              )}
            </article>
          );
        })}
        {error && (
          <div className={styles.connectionError} role="alert">
            <p>
              The conversation could not be opened. Your grid is still
              available.
            </p>
            <button type="button" onClick={() => setGeneration((g) => g + 1)}>
              Reconnect
            </button>
          </div>
        )}
        {running && (
          <div className={styles.working} role="status">
            <span className={styles.pulse} />
            {elapsed < 6
              ? "Reading your question…"
              : `Still working · ${elapsed}s`}
          </div>
        )}
      </div>
      <form
        className={styles.composer}
        onSubmit={(e) => {
          e.preventDefault();
          send(prompt);
        }}
      >
        <label className={styles.srOnly} htmlFor="workspace-ai-request">
          Your question
        </label>
        <div className={styles.inputBox}>
          <textarea
            ref={inputRef}
            id="workspace-ai-request"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            maxLength={800}
            rows={2}
            placeholder="Ask about your store…"
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (!running) e.currentTarget.form?.requestSubmit();
              }
            }}
          />
          <div className={styles.inputFooter}>
            <span>Enter to send · Shift + Enter for a new line</span>
            {running ? (
              <button
                className={styles.send}
                type="button"
                aria-label="Stop"
                title="Stop response"
                onClick={() => session?.cancel()}
              >
                <Icon name="stop" />
              </button>
            ) : (
              <button
                className={styles.send}
                type="submit"
                aria-label="Ask GuardBuy"
                title="Send question"
                disabled={!session || !prompt.trim()}
              >
                <Icon name="send" />
              </button>
            )}
          </div>
        </div>
        <p className={styles.privacy}>
          Some questions use an external AI service. Keep sensitive information
          out.
        </p>
        {checkedAt && (
          <small className={styles.timestamp}>
            Snapshot {readableTime(checkedAt)}
          </small>
        )}
      </form>
    </div>
  );
}
