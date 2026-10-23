import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";

type ToastKind = "info" | "success" | "error";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
}

type Notify = (text: string, kind?: ToastKind) => void;
const ToastContext = createContext<Notify>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const notify = useCallback<Notify>((text, kind = "info") => {
    const id = nextId.current++;
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    window.setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "error" ? 6000 : 3000);
  }, []);

  const value = useMemo(() => notify, [notify]);
  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast toast--${t.kind}`}>
            <ToastMark kind={t.kind} />
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

/** A pencil tick, exclamation mark or dot before the text: the note's kind at a glance. */
const MARKS: Record<ToastKind, string> = {
  success: "M3.5 10.5c1.6 1.3 2.8 2.6 3.8 4.2C9.4 10 12 6.6 16.6 3.8",
  error: "M10 3.6c-.2 3-.1 5.6.2 8.2M10.1 15.6v.3",
  info: "M10 9.4c-.1 2-.1 3.8.1 5.8M10 5.2v.3",
};

function ToastMark({ kind }: { kind: ToastKind }) {
  return (
    <svg className="toast__mark" viewBox="0 0 20 20" width="20" height="20" aria-hidden>
      <path d={MARKS[kind]} />
    </svg>
  );
}

export function useToast(): Notify {
  return useContext(ToastContext);
}
