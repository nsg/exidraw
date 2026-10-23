import { useEffect, useRef, type ReactNode } from "react";
import { CrossIcon, PencilOutline, PencilRule, sheetRoughness, useElementSize } from "../sketch/Paper";

/**
 * How far the sheet's decoration reaches past its edges: the tape (15px above),
 * the pencil outline (6px), the tilt. Presses there are on the sheet, not beside it.
 */
const DECORATION_REACH = 20;

interface ModalProps {
  title: string;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
}

/**
 * Native <dialog> modal: focus trap, Esc and backdrop handling come for free.
 * It is a taped sheet of paper outlined in pencil; the <dialog> itself is the
 * transparent backdrop around it, so a press beside the sheet closes it.
 */
export function Modal({ title, onClose, children, footer, wide }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null);
  const sheet = useRef<HTMLDivElement>(null);
  // The outline follows the sheet as its content loads and changes.
  const size = useElementSize(sheet);
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
        const dialog = ref.current!;
        if (e.target !== dialog) return;
        // The dialog's own scrollbar, when a tall sheet scrolls, is not the backdrop either.
        const box = dialog.getBoundingClientRect();
        if (e.clientX >= box.left + dialog.clientWidth || e.clientY >= box.top + dialog.clientHeight) return;
        const r = sheet.current!.getBoundingClientRect();
        const d = DECORATION_REACH;
        const onSheet = e.clientX >= r.left - d && e.clientX <= r.right + d && e.clientY >= r.top - d && e.clientY <= r.bottom + d;
        if (!onSheet) onClose();
      }}
    >
      <div className="modal__sheet" ref={sheet}>
        <div className="modal__tape" aria-hidden />
        {size && <PencilOutline size={size} className="modal__border" roughness={sheetRoughness(size)} />}
        <div className="modal__header">
          <h2 className="modal__title">{title}</h2>
          <button type="button" className="close-btn" aria-label="Close" onClick={onClose}>
            <CrossIcon />
          </button>
        </div>
        <div className="modal__body">{children}</div>
        {footer && (
          <div className="modal__footer">
            <PencilRule id={`modal-foot:${title}`} />
            {footer}
          </div>
        )}
      </div>
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
          <span className="field__label">{label}</span>
          <input ref={inputRef} className="sketch-input" defaultValue={initial} autoFocus required maxLength={120} />
        </label>
        <div className="form__actions">
          <button type="button" className="sketch-btn" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="sketch-btn sketch-btn--primary">
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
          <button type="button" className="sketch-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className={`sketch-btn ${danger ? "sketch-btn--danger" : "sketch-btn--primary"}`}
            autoFocus
            onClick={() => void onConfirm()}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <p className="modal__message">{message}</p>
    </Modal>
  );
}
