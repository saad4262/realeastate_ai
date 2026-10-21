import type { Metadata } from 'next';
import { WebShell } from '../../../components/web-shell';
import { LEGAL } from '../legal';
import styles from '../legal.module.css';

export const metadata: Metadata = {
  title: `Privacy policy — ${LEGAL.siteName}`,
  description: `How ${LEGAL.siteName} collects, uses, stores and deletes personal information.`,
};

/**
 * The privacy policy (ADR 0037). Linked from the Zoom Marketplace listing and
 * required for its review. What it says about integrations must stay true to
 * the code: the scopes in packages/core/src/integrations/providers.ts, tokens
 * encrypted at rest, and Zoom access deleted on deauthorization.
 */
export default function PrivacyPolicyPage() {
  return (
    <WebShell>
      <article className={styles.page}>
        <h1 className={styles.title}>Privacy policy</h1>
        <p className={styles.meta}>Effective {LEGAL.effective}</p>

        <p>
          {LEGAL.siteName} is operated by {LEGAL.company} (“we”, “us”). We help people search
          Australian property listings, and we give real estate agencies and their agents
          software to manage listings, contacts, enquiries, emails and appointments. This policy
          explains how we handle personal information under the <em>Privacy Act 1988</em> (Cth)
          and the Australian Privacy Principles.
        </p>

        <h2>Information we collect</h2>
        <h3>If you use the public website</h3>
        <ul>
          <li>Account details: your name, email address and password (passwords are handled by our sign-in provider and never stored by us in readable form).</li>
          <li>What you send us: enquiries and offers about a property, messages to an agency, saved searches and email alert preferences.</li>
          <li>Conversations with the AI property guide, so you can return to them.</li>
          <li>
            What you search for and which listings you open. If you are signed in, we keep this with your account
            (including your search filters) to understand what our users look for and to improve the service. If you
            are not signed in, we only count it — the suburb and the listing — without anything that identifies you.
          </li>
          <li>Basic technical information, such as your IP address, used to keep the service secure and to limit abuse.</li>
        </ul>
        <h3>If you work for an agency that uses our software</h3>
        <ul>
          <li>Your name, email address, role and the agency you belong to.</li>
          <li>The records you and your agency keep in it: listings, contacts, notes, enquiries, emails, appointments and dashboards.</li>
          <li>Accounts you choose to connect, such as Google Calendar, Gmail or Zoom (see “Connected accounts” below).</li>
        </ul>
        <h3>Information about people in an agency’s records</h3>
        <p>
          Agencies store details of their clients and enquirers (for example a name, email address,
          phone number and the history of their dealings with the agency). For that information the
          agency decides why it is collected and how it is used, and we process it on the agency’s
          behalf. If you are in an agency’s records, you can also contact that agency directly.
        </p>

        <h2>How we use it</h2>
        <ul>
          <li>To provide the service: show listings, pass your enquiry to the agency it is about, send the emails and alerts you asked for, and run the agency tools.</li>
          <li>To keep it secure: authenticate you, prevent fraud and abuse, and investigate problems.</li>
          <li>To contact you about your account or the service.</li>
          <li>Marketing emails are sent only with consent and always include a working unsubscribe link, as the <em>Spam Act 2003</em> requires.</li>
        </ul>
        <p>We do not sell personal information.</p>

        <h2>Artificial intelligence</h2>
        <p>
          Some features use AI models provided by Anthropic: the property guide on the website, and an
          assistant and writing tools inside the agency software. The text you type into those features,
          and the records needed to answer it, are sent to the model provider to produce a response.
          Prices, medians and other figures we show come from our database, not from the model.
          AI-written listing copy is always a draft that a person at the agency must review before it is
          published. Our model provider does not use this data to train its models under the commercial
          terms we use.
        </p>

        <h2>Connected accounts (Google and Zoom)</h2>
        <p>
          An agent or agency can choose to connect a Google or Zoom account. We ask only for the
          permissions a feature needs, and we show why on the screen where you connect:
        </p>
        <ul>
          <li><strong>Zoom</strong>: to create, update and delete Zoom meetings for appointments booked in our software, and to read your Zoom user id and email address so we can show which account is connected.</li>
          <li><strong>Google Calendar</strong>: to add, move and remove the events for those appointments on calendars you own.</li>
          <li><strong>Gmail</strong> (send only): to send emails you write in our software from your own address. We do not read your inbox.</li>
        </ul>
        <p>
          Access and refresh tokens for these accounts are encrypted before they are stored, are never
          shown in the browser, and are used only by our servers to perform the action you asked for.
          You can disconnect an account at any time in Settings → Integrations, which deletes the
          stored tokens. If you remove our app from inside your Zoom account, Zoom notifies us and we
          delete the stored Zoom access for that Zoom user straight away. Meeting links already saved
          on appointments stay part of those appointment records, which belong to your agency.
        </p>
        <p>
          Our use of information received from Google APIs adheres to the Google API Services User Data
          Policy, including the Limited Use requirements.
        </p>

        <h2>Who we share it with</h2>
        <p>We use these service providers to run the service. Each processes data only to provide its service to us:</p>
        <ul>
          <li>Supabase: database, sign-in and file storage.</li>
          <li>Vercel: website and application hosting.</li>
          <li>Resend: sending and receiving email.</li>
          <li>Anthropic: AI models (see above). If search over notes and emails is turned on for an agency, Voyage AI creates search indexes from that text.</li>
          <li>Google: maps, address lookup and agency reviews, and the Google accounts you connect.</li>
          <li>Zoom: the Zoom account you connect.</li>
        </ul>
        <p>
          When you send an enquiry, offer or message, the agency it is addressed to receives it. We may
          also disclose information where the law requires it.
        </p>

        <h2>Where it is stored, and overseas disclosure</h2>
        <p>
          Our main database is hosted in [Sydney, Australia]. Some providers above, including Anthropic,
          Resend, Vercel, Google and Zoom, may process information in the United States and other
          countries. We take reasonable steps, including through our contracts with them, to make sure
          they handle it consistently with the Australian Privacy Principles.
        </p>

        <h2>How long we keep it, and deletion</h2>
        <ul>
          <li>Account information is kept while your account is open. You can ask us to delete your account at any time.</li>
          <li>Files uploaded for a listing import are deleted 30 days after the import.</li>
          <li>Connected-account tokens are deleted when you disconnect, or when you remove our app from your Zoom account.</li>
          <li>Agency records are kept for as long as the agency uses the service and then deleted or returned as agreed with the agency, unless the law requires us to keep them longer.</li>
        </ul>

        <h2>Security</h2>
        <p>
          Information is encrypted in transit. Browsers cannot read our database directly: every request
          goes through our servers, which check who is asking and what they may see. Each agency’s data is
          kept separate from every other agency’s. No system is perfectly secure; if a data breach is
          likely to cause serious harm, we will notify you and the Office of the Australian Information
          Commissioner as the law requires.
        </p>

        <h2>Access, correction and complaints</h2>
        <p>
          You can ask for a copy of the personal information we hold about you, ask us to correct it, or
          ask us to delete it, by emailing {LEGAL.privacyEmail}. We will reply within 30 days. If you are
          not satisfied with our response, you can complain to the Office of the Australian Information
          Commissioner at oaic.gov.au.
        </p>

        <h2>Changes</h2>
        <p>
          We will post any change to this policy on this page with a new effective date, and tell account
          holders by email about significant changes.
        </p>

        <h2>Contact</h2>
        <p>
          {LEGAL.company}
          <br />
          {LEGAL.address}
          <br />
          {LEGAL.privacyEmail}
        </p>
      </article>
    </WebShell>
  );
}
