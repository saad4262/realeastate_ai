import { NextResponse, type NextRequest } from 'next/server';
import { returnUri, stubEnabled, tokenKeysFromEnv, verifyState, PROVIDERS } from '@repo/core/integrations';

/**
 * The dev-only pretend provider's consent page (docs/adr/0020). Lists the
 * scopes with checkboxes — untick one to test `permission_missing` — and
 * answers through the same return route a real provider would. Refuses to
 * exist in production or without INTEGRATIONS_STUB=1.
 */
export const dynamic = 'force-dynamic';

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

export async function GET(request: NextRequest) {
  const keys = tokenKeysFromEnv();
  if (!stubEnabled() || !keys) return new NextResponse('Not found', { status: 404 });
  const q = request.nextUrl.searchParams;
  const state = verifyState(q.get('state'), keys);
  // Only ever back to our own return route — never to a redirect_uri from the URL.
  if (!state || q.get('redirect_uri') !== returnUri()) return new NextResponse('That link is not valid.', { status: 400 });
  const scopes = (q.get('scope') ?? '').split(' ').filter(Boolean);
  const provider = PROVIDERS[state.provider];
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pretend ${esc(provider.label)} — dev only</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:34rem;margin:3rem auto;padding:0 1rem;color:#1a1a1a}
.box{border:1px solid #ccc;border-radius:12px;padding:1.25rem}.warn{background:#fff7e0;border:1px solid #f0c040;border-radius:8px;padding:.5rem .75rem;font-size:13px}
label{display:block;margin:.4rem 0}button{padding:.5rem 1rem;border-radius:8px;border:1px solid #1a1a1a;background:#1a1a1a;color:#fff;font:inherit;margin-right:.5rem}
button.ghost{background:#fff;color:#1a1a1a}input[type=text]{width:100%;padding:.4rem;font:inherit}</style></head>
<body><div class="box"><p class="warn">Development stub — no real ${esc(provider.label)} account is involved.</p>
<h1 style="font-size:1.2rem">Connect ${esc(provider.label)}</h1>
<form method="get" action="/integrations/stub/decide">
<input type="hidden" name="state" value="${esc(q.get('state') ?? '')}">
<p>The app asks for these permissions — untick one to test “permission missing”:</p>
${scopes.map((s) => `<label><input type="checkbox" name="granted" value="${esc(s)}" checked> <code>${esc(s)}</code></label>`).join('\n')}
<p><label>Account shown as <input type="text" name="label" value="stub.${esc(state.provider)}@example.test" maxlength="120"></label></p>
<button type="submit" name="decision" value="allow">Allow</button><button class="ghost" type="submit" name="decision" value="deny">Deny</button>
</form></div></body></html>`;
  return new NextResponse(html, { headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
