import { NextResponse, type NextRequest } from 'next/server';
import { returnUri, stubEnabled, tokenKeysFromEnv, verifyState } from '@repo/core/integrations';

/** The stub consent page's answer: back to the return route with a stub code (or an error), like a provider. */
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const keys = tokenKeysFromEnv();
  if (!stubEnabled() || !keys) return new NextResponse('Not found', { status: 404 });
  const q = request.nextUrl.searchParams;
  const state = q.get('state') ?? '';
  if (!verifyState(state, keys)) return new NextResponse('That link is not valid.', { status: 400 });
  const back = new URL(returnUri());
  back.searchParams.set('state', state);
  if (q.get('decision') !== 'allow') {
    back.searchParams.set('error', 'access_denied');
  } else {
    const code = Buffer.from(JSON.stringify({ scopes: q.getAll('granted'), label: q.get('label') ?? '' })).toString('base64url');
    back.searchParams.set('code', `stub.${code}`);
  }
  return NextResponse.redirect(back.toString());
}
