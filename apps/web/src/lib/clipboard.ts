/**
 * Copies text, and says whether it worked.
 *
 * Browsers only offer the Clipboard API over HTTPS or on localhost, and most self-hosted
 * installs are reached over plain HTTP on the local network. There, fall back to selecting
 * the text in a hidden field and copying it the old way, which still works on a click.
 */
export async function copyText(text: string): Promise<boolean> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Refused (permissions, an unfocused page): try the fallback below.
    }
  }
  return copyBySelecting(text);
}

function copyBySelecting(text: string): boolean {
  const before = document.activeElement as HTMLElement | null;
  // Everything outside an open modal dialog is inert and can't be selected, so put the
  // field inside the dialog the click came from.
  const host = before?.closest("dialog") ?? document.body;
  const field = document.createElement("textarea");
  field.value = text;
  field.readOnly = true;
  field.setAttribute("aria-hidden", "true");
  // Off screen, but not display:none, which can't be selected. 16px stops iOS zooming in.
  field.style.cssText = "position:fixed;top:0;left:-9999px;opacity:0;font-size:16px";
  host.appendChild(field);
  field.focus();
  field.select();
  field.setSelectionRange(0, text.length);
  let ok = false;
  try {
    ok = document.execCommand("copy");
  } catch {
    ok = false;
  }
  field.remove();
  before?.focus?.();
  return ok;
}
