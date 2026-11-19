import { seed } from './fixture';
export default async function globalSetup() {
  await seed();
}
