import { teardown } from './fixture';
export default async function globalTeardown() {
  if (process.env.E2E_KEEP !== '1') await teardown();
}
