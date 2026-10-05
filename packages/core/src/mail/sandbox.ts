/**
 * A received email's HTML, made safe to show in an `<iframe srcdoc sandbox>`.
 *
 * The sandbox is the boundary, not this function: the console renders the
 * result in an iframe with `sandbox="allow-popups allow-popups-to-escape-sandbox"`
 * — no scripts, no forms, no same-origin, so the email cannot touch the console,
 * its cookies or its session. What this adds is the part a sandbox does not do:
 *
 *  - a Content-Security-Policy as the very first thing in the document, which
 *    blocks every network fetch the email would make. Remote images in email
 *    are mostly tracking pixels; opening a buyer's mail should not tell a third
 *    party that it was read, or from where. Inline `data:` images still show.
 *  - `<base target="_blank">`, so a link opens a new tab instead of trying to
 *    navigate inside a frame that cannot.
 *
 * The CSP meta comes first because a meta policy only governs what is parsed
 * after it, and because a later policy in the email itself can only ADD
 * restrictions — several policies all apply — never loosen this one.
 */
export const EMAIL_FRAME_SANDBOX = 'allow-popups allow-popups-to-escape-sandbox';

const POLICY = [
  "default-src 'none'",
  'img-src data: cid:',
  "style-src 'unsafe-inline'",
  'font-src data:',
  "form-action 'none'",
].join('; ');

export function sandboxedEmailDocument(html: string): string {
  return [
    `<meta http-equiv="Content-Security-Policy" content="${POLICY}">`,
    '<meta charset="utf-8">',
    '<base target="_blank">',
    '<style>body{margin:0;padding:12px;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#1a1a1a;word-wrap:break-word}img{max-width:100%;height:auto}</style>',
    html,
  ].join('\n');
}
