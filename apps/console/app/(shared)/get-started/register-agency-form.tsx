'use client';

import { useState, type FormEvent } from 'react';
import { registerAgencyAction } from '../account-actions';
import styles from '../auth.module.css';

export function RegisterAgencyForm({
  defaultOwnerName,
  agencyUrl,
}: {
  defaultOwnerName: string;
  agencyUrl: string;
}) {
  const [agencyName, setAgencyName] = useState('');
  const [ownerName, setOwnerName] = useState(defaultOwnerName);
  const [abn, setAbn] = useState('');
  const [phone, setPhone] = useState('');
  const [officeName, setOfficeName] = useState('Head Office');
  const [officeAddress, setOfficeAddress] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    setError(null);

    const result = await registerAgencyAction({
      agencyName,
      ownerName,
      abn,
      phone,
      officeName,
      officeAddress,
    });

    if (!result.ok) {
      // Already a member: the console will route them correctly.
      if (result.code === 'already_member') {
        window.location.href = `${agencyUrl}/overview`;
        return;
      }
      setError(result.error);
      setLoading(false);
      return;
    }

    // Agency surface lives on its own host — full navigation, not a router push.
    window.location.href = `${agencyUrl}/overview`;
  }

  return (
    <form className={styles.form} onSubmit={onSubmit}>
      <div className={styles.field}>
        <label htmlFor="agency-name">Agency Name</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>domain</span>
          </span>
          <input
            id="agency-name"
            className={styles.input}
            type="text"
            required
            minLength={2}
            placeholder="Bondi Prestige Group"
            value={agencyName}
            onChange={(e) => setAgencyName(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="owner-name">Licensee in Charge</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>person</span>
          </span>
          <input
            id="owner-name"
            className={styles.input}
            type="text"
            required
            minLength={2}
            placeholder="Jane Doe"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="agency-abn">ABN (optional)</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>badge</span>
          </span>
          <input
            id="agency-abn"
            className={styles.input}
            type="text"
            inputMode="numeric"
            pattern="\d{11}"
            placeholder="11 digits"
            value={abn}
            onChange={(e) => setAbn(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="agency-phone">Phone (optional)</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>call</span>
          </span>
          <input
            id="agency-phone"
            className={styles.input}
            type="tel"
            placeholder="+61 2 9000 0000"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="office-name">First Office</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>store</span>
          </span>
          <input
            id="office-name"
            className={styles.input}
            type="text"
            required
            minLength={2}
            value={officeName}
            onChange={(e) => setOfficeName(e.target.value)}
          />
        </div>
      </div>

      <div className={styles.field}>
        <label htmlFor="office-address">Office Address (optional)</label>
        <div className={styles.inputWrap}>
          <span className={styles.inputIcon} aria-hidden>
            <span className={styles.glyph}>location_on</span>
          </span>
          <input
            id="office-address"
            className={styles.input}
            type="text"
            placeholder="1 Campbell Pde, Bondi Beach NSW 2026"
            value={officeAddress}
            onChange={(e) => setOfficeAddress(e.target.value)}
          />
        </div>
      </div>

      {error ? <p className={styles.error}>{error}</p> : null}

      <button className={styles.submit} type="submit" disabled={loading}>
        <span>{loading ? 'Creating agency…' : 'Create Agency'}</span>
        {!loading ? <span className={styles.glyph}>arrow_forward</span> : null}
      </button>
    </form>
  );
}
