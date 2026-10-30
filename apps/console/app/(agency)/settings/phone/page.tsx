import { PhoneSetupScreen } from '@/components/phone/phone-setup-screen';

/** Connectors → Phone & SMS (docs/adr/0070): the agency's own Twilio, its business check, a number per agent. */
export default function Page() {
  return <PhoneSetupScreen />;
}
