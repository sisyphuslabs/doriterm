import { AlertDialog as BaseAlertDialog } from "@base-ui/react/alert-dialog";
import { Dialog as BaseDialog } from "@base-ui/react/dialog";
import { useId, useRef, type ReactElement, type ReactNode } from "react";
import { cn } from "../lib/cn.ts";
import { backdropClass, modalLayer, overlaySurface } from "./overlay.ts";

export interface DialogProps {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  /** Buttons, trailing primary. */
  readonly actions?: ReactNode;
  readonly trigger?: ReactElement;
  readonly open?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  /** Where focus goes once it closes: an element, or true for the element that had focus when it opened. */
  readonly finalFocus?: () => HTMLElement | true;
  readonly className?: string;
  /** A statement to acknowledge (`alertdialog`): read out as it opens, and a click outside leaves it up. */
  readonly alert?: boolean;
}

/** Inside the viewport both ways: a 1rem margin each side, and a long question scrolls inside instead of off screen. */
const popupClass = "w-[min(28rem,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto p-5";
/** What a dialog opens in when it has one: the field it asks for, never a button. */
const fieldSelector = "input:not([type=hidden]):not(:disabled), textarea:not(:disabled), select:not(:disabled)";
const titleClass = "text-xl font-semibold text-foreground";
const descriptionClass = "mt-1.5 text-base text-pretty text-muted-foreground";

function Body({ children, actions }: Pick<DialogProps, "children" | "actions">) {
  return (
    <>
      {children === undefined ? null : <div className="mt-4">{children}</div>}
      {actions === undefined ? null : <div className="mt-5 flex flex-wrap justify-end gap-2">{actions}</div>}
    </>
  );
}

/** A modal question. Title states the situation; the description is at most two short sentences. */
export function Dialog({
  title,
  description,
  children,
  actions,
  trigger,
  open,
  onOpenChange,
  finalFocus,
  className,
  alert = false,
}: DialogProps) {
  const state = { ...(open === undefined ? {} : { open }), ...(onOpenChange === undefined ? {} : { onOpenChange }) };
  const panel = useRef<HTMLDivElement>(null);
  // No answer is the default (#1495): a question opens on the dialog itself, named by its title, so Enter neither
  // confirms nor cancels and Tab reaches the buttons in order. A dialog that asks for text opens in its field. A
  // question taller than the screen opens at its title too, since focusing a field below the fold would scroll it away.
  // A statement to acknowledge (an alert with one button, OK) has no choice to default to, so OK keeps focus; an alert
  // that asks (Cancel and an action) opens on itself like any question.
  const initialTarget = (): HTMLElement | true => {
    const element = panel.current;
    if (element === null) return true;
    if (element.scrollHeight > element.clientHeight) return element;
    const buttons = element.querySelectorAll<HTMLButtonElement>("button");
    // A lone button that cannot take focus leaves the statement on itself, not the keyboard behind it (#2102).
    if (alert && buttons.length === 1) return buttons[0]?.disabled === false ? buttons[0] : element;
    return element.querySelector<HTMLElement>(fieldSelector) ?? element;
  };
  // The dialog takes the keyboard as it opens (#2046). Base UI would focus it a frame later, and on a busy page a key
  // pressed before that frame goes to whatever had focus behind the dialog: a terminal or a button that keeps Escape.
  const initialFocus = () => {
    const target = initialTarget();
    if (target === true) return true;
    target.focus({ preventScroll: target === panel.current });
    return false;
  };
  const popup = (
    <BaseDialog.Portal>
      <BaseDialog.Backdrop className={backdropClass} />
      <BaseDialog.Popup
        ref={panel}
        // Modal (the page behind takes no input), and says so: a toast is a dialog too, but not a modal one (#2380).
        aria-modal="true"
        initialFocus={initialFocus}
        {...(finalFocus === undefined ? {} : { finalFocus })}
        className={cn(
          overlaySurface,
          modalLayer,
          "fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2",
          popupClass,
          className,
        )}
      >
        <BaseDialog.Title className={titleClass}>{title}</BaseDialog.Title>
        {description === undefined ? null : (
          <BaseDialog.Description className={descriptionClass}>{description}</BaseDialog.Description>
        )}
        <Body actions={actions}>{children}</Body>
      </BaseDialog.Popup>
    </BaseDialog.Portal>
  );
  if (alert) {
    return (
      <BaseAlertDialog.Root {...state}>
        {trigger === undefined ? null : <BaseAlertDialog.Trigger render={trigger} />}
        {popup}
      </BaseAlertDialog.Root>
    );
  }
  return (
    <BaseDialog.Root {...state}>
      {trigger === undefined ? null : <BaseDialog.Trigger render={trigger} />}
      {popup}
    </BaseDialog.Root>
  );
}

export type DialogPanelProps = Pick<DialogProps, "title" | "description" | "children" | "actions" | "className">;

/** The same panel drawn in place, for static compositions and previews of an open dialog. */
export function DialogPanel({ title, description, children, actions, className }: DialogPanelProps) {
  const id = useId();
  return (
    <div role="dialog" aria-labelledby={`${id}-title`} className={cn(overlaySurface, popupClass, className)}>
      <h2 id={`${id}-title`} className={titleClass}>
        {title}
      </h2>
      {description === undefined ? null : <p className={descriptionClass}>{description}</p>}
      <Body actions={actions}>{children}</Body>
    </div>
  );
}

export const DialogClose = BaseDialog.Close;
