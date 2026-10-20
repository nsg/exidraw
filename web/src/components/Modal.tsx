import { useEffect, useRef, type ReactNode } from "react";

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/** Native <dialog> modal: focus trap, Esc and backdrop handling come for free. */
export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const dialog = ref.current!;
    dialog.showModal();
    const handleCancel = (e: Event) => {
      e.preventDefault();
      onCloseRef.current();
    };
    dialog.addEventListener("cancel", handleCancel);
    return () => {
      dialog.removeEventListener("cancel", handleCancel);
      dialog.close();
    };
  }, []);

  return (
    <dialog
      ref={ref}
      className={`modal${wide ? " modal--wide" : ""}`}
      aria-label={title}
      onMouseDown={(e) => {
        if (e.target === ref.current) onClose();
      }}
    >
      <div className="modal__header">
        <h2>{title}</h2>
        <button type="button" className="icon-btn" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="modal__body">{children}</div>
      {footer && <div className="modal__footer">{footer}</div>}
    </dialog>
  );
}

interface PromptProps {
  title: string;
  label: string;
  initial?: string;
  submitLabel: string;
  onSubmit: (value: string) => Promise<void>;
  onClose: () => void;
}

/** Single text field dialog (create/rename). */
export function PromptDialog({ title, label, initial = "", submitLabel, onSubmit, onClose }: PromptProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const busy = useRef(false);
  return (
    <Modal title={title} onClose={onClose}>
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          const value = inputRef.current!.value.trim();
          if (!value || busy.current) return;
          busy.current = true;
          try {
            await onSubmit(value);
          } finally {
            busy.current = false;
          }
        }}
      >
        <label className="field">
          <span>{label}</span>
          <input ref={inputRef} defaultValue={initial} autoFocus required maxLength={120} />
        </label>
        <div className="form__actions">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn--primary">
            {submitLabel}
          </button>
        </div>
      </form>
    </Modal>
  );
}

interface ConfirmProps {
  title: string;
  message: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}

export function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onClose }: ConfirmProps) {
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`btn ${danger ? "btn--danger" : "btn--primary"}`}
            autoFocus
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p>{message}</p>
    </Modal>
  );
}
