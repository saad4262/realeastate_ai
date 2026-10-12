import type { Metadata } from 'next';
import Link from 'next/link';
import { WebShell } from '../../../components/web-shell';
import { LEGAL } from '../legal';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: `Terms of service — ${LEGAL.siteName}`,
  description: `The terms for using ${LEGAL.siteName}.`,
};

/** The terms of service (ADR 0037). Linked from the Zoom Marketplace listing and required for its review. */
export default function TermsOfServicePage() {
  return (
    <WebShell>
      <article className={styles.page}>
        <h1 className={styles.title}>Terms of service</h1>
        <p className={styles.meta}>Effective {LEGAL.effective}</p>

        <p>
          These terms apply to {LEGAL.siteName}, operated by {LEGAL.company} (“we”, “us”): the public
          property website and the software we provide to real estate agencies and their agents. By using
          either, you agree to these terms. Our{' '}
          <Link href="/privacy-policy">privacy policy</Link> explains how we handle personal information.
        </p>

        <h2>1. Accounts</h2>
        <p>
          You must give accurate details when you create an account and keep your password secure. You
          are responsible for what happens under your account. Tell us at {LEGAL.supportEmail} if you think
          someone else has used it.
        </p>

        <h2>2. Listings and property information</h2>
        <p>
          Listings, prices, photos and descriptions are provided by the agencies that advertise them. We
          do not verify them and do not act as a real estate agent. Check anything important with the
          agency, and get independent advice, before you make a decision about a property. Figures such as
          sold prices and medians come from the data we hold and may be incomplete or out of date.
        </p>

        <h2>3. The AI property guide and AI tools</h2>
        <p>
          Some features use artificial intelligence. Their answers can be wrong or incomplete and are not
          financial, legal or real estate advice. Content written with AI help in the agency software is a
          draft: the agency is responsible for reviewing it before it is published or sent to anyone else.
        </p>

        <h2>4. Agencies and agents</h2>
        <ul>
          <li>An agency is responsible for the people it invites, the roles it gives them, and the records it keeps in the software.</li>
          <li>An agency must have the right to store and use the personal information it adds, and must comply with the <em>Privacy Act 1988</em> (Cth), the <em>Spam Act 2003</em> (Cth) and the real estate laws that apply to it, including rules on advertising and price representations.</li>
          <li>An agency must hold the rights to the photos and other material it uploads.</li>
          <li>Fees, billing periods and cancellation for agencies are set out in [the agency’s plan or order form].</li>
        </ul>

        <h2>5. Connected accounts (Google and Zoom)</h2>
        <p>
          You can connect a Google or Zoom account to book meetings, keep your calendar in step and send
          email from your own address. When you do, you authorise us to act in that account only for those
          features, and the provider’s own terms also apply to your use of it. You can disconnect at any
          time in Settings → Integrations, or by removing our app inside your Google or Zoom account. We are
          not responsible for outages or changes at those providers.
        </p>

        <h2>6. Acceptable use</h2>
        <p>You must not:</p>
        <ul>
          <li>use the service to send spam or messages to people who have not agreed to receive them;</li>
          <li>post false or misleading listings or content;</li>
          <li>try to reach another agency’s data or anyone else’s account;</li>
          <li>copy listings or photos in bulk, scrape the site, or overload or interfere with the service;</li>
          <li>use the service for anything unlawful.</li>
        </ul>
        <p>We may suspend or close an account that breaks these rules.</p>

        <h2>7. Your content and ours</h2>
        <p>
          You keep ownership of the content you add. You give us the permission we need to store, process
          and display it to provide the service. The software, the site design and our own content belong
          to us or our licensors.
        </p>

        <h2>8. Availability and changes</h2>
        <p>
          We work to keep the service available, but it may sometimes be interrupted for maintenance or
          for reasons outside our control. We may change or stop features, and will give agencies
          reasonable notice of a change that significantly affects them.
        </p>

        <h2>9. Liability</h2>
        <p>
          Nothing in these terms excludes rights you have under the Australian Consumer Law that cannot be
          excluded. Subject to that, we are not liable for indirect or consequential loss, and our total
          liability to you in connection with the service is limited, where the law allows, to resupplying
          the service or the fees you paid us in the 12 months before the claim.
        </p>

        <h2>10. Ending your use</h2>
        <p>
          You can stop using the service and ask us to close your account at any time. We may close an
          account that breaches these terms. Sections 7 and 9 continue after an account closes.
        </p>

        <h2>11. Changes to these terms</h2>
        <p>
          We may update these terms. We will post the new version here with a new effective date and tell
          account holders about significant changes by email before they take effect.
        </p>

        <h2>12. Governing law</h2>
        <p>
          These terms are governed by the laws of {LEGAL.governingState}, Australia, and you agree to the
          jurisdiction of its courts.
        </p>

        <h2>Contact</h2>
        <p>
          {LEGAL.company}
          <br />
          {LEGAL.address}
          <br />
          {LEGAL.supportEmail}
        </p>
      </article>
    </WebShell>
  );
}
