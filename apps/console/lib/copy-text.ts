/**
 * Copy text to the clipboard, reporting honestly whether it worked.
 *
 * navigator.clipboard exists only in a secure context, and the console runs on
 * plain http://*.lvh.me in dev, so in that setting the modern API is simply
 * absent. The execCommand path still works there. A hard failure has to be
 * reported rather than swallowed: telling someone a claim link is on their
 * clipboard when it is not sends them to paste nothing into a message.
 */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission refused or not a secure context — try the legacy path.
  }

  try {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    // Off-screen but still focusable; display:none would break the selection.
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    field.setSelectionRange(0, text.length);
    const ok = document.execCommand('copy');
    document.body.removeChild(field);
    return ok;
  } catch {
    return false;
  }
}
