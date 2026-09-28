'use client';

import { useState, useTransition, type ChangeEvent } from 'react';
import { mediaUrl } from '@repo/core/media/url';
import { signOnboardingPhotoUploadAction } from '../../../../lib/media-actions';
import { putSignedUpload } from '../../../../lib/upload-file';
import styles from './wizard.module.css';

/**
 * The headshot, uploaded rather than linked.
 *
 * This field used to be a URL box with "R2 upload lands with media milestone"
 * under it. The media milestone landed — on Supabase Storage, ADR 0009 — so it
 * uploads.
 *
 * ## Uploading before the agent exists
 *
 * The wizard's draft lives in this browser until the invite is dispatched;
 * there is no user id and no agent_profile row to key a path on. The file is
 * keyed on the **agency** instead, which the server takes from the session and
 * never from here, and `inviteAgent` writes that key onto the profile row it
 * creates. A later upload from the team drawer replaces it with an
 * agent-scoped key and deletes this one.
 *
 * ## The URL box stays
 *
 * An agency that already hosts its headshots somewhere should not have to
 * re-upload them, and `photo_url` is the column that has always held those.
 * The uploaded key wins wherever both exist — an upload is a deliberate act,
 * a pasted link is something typed once — which is the same rule the public
 * agent panel and the team directory follow.
 */
export function PhotoField({
  photoUrl,
  photoKey,
  onChange,
  inputClassName,
  onBlurUrl,
  urlInvalid,
}: {
  photoUrl: string | null;
  photoKey: string | null;
  onChange: (patch: { photoUrl?: string | null; photoKey?: string | null }) => void;
  inputClassName: string;
  onBlurUrl: () => void;
  urlInvalid: boolean;
}) {
  const [busy, start] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const uploaded = mediaUrl(photoKey);
  const preview = uploaded ?? photoUrl;

  function onPick(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Cleared immediately so picking the same file twice still fires.
    event.target.value = '';
    if (!file) return;

    setError(null);
    start(async () => {
      try {
        const signed = await signOnboardingPhotoUploadAction({
          type: file.type,
          size: file.size,
        });
        if (!signed.ok) {
          setError(signed.error);
          return;
        }

        await putSignedUpload(signed, file);
        // Recorded on the draft only after the bytes are actually there, so a
        // failed upload never leaves the wizard pointing at nothing.
        onChange({ photoKey: signed.key });
      } catch (err) {
        setError(err instanceof Error ? err.message : 'That photo could not be uploaded.');
      }
    });
  }

  return (
    <div className={styles.photoCard}>
      <div style={{ position: 'relative' }}>
        {preview ? (
          /* eslint-disable-next-line @next/next/no-img-element -- the console
             is not on next/image anywhere; see team-directory.tsx. */
          <img className={styles.photo} src={preview} alt="" />
        ) : (
          <div className={styles.photoEmpty} aria-hidden>
            No photo
          </div>
        )}
      </div>

      <div style={{ marginTop: 8, fontWeight: 600, fontSize: 13 }}>Executive Roster Headshot</div>

      <div className={styles.photoActions}>
        <label className={styles.photoPick} aria-disabled={busy}>
          <input
            type="file"
            className={styles.photoFile}
            accept="image/jpeg,image/png,image/webp,image/avif"
            disabled={busy}
            onChange={onPick}
          />
          {busy ? 'Uploading…' : uploaded ? 'Replace photo' : 'Upload photo'}
        </label>

        {/* Only an upload can be removed here. A pasted link belongs to the
            field below it, which the agency can simply clear. */}
        {uploaded ? (
          <button
            type="button"
            className={styles.photoClear}
            disabled={busy}
            onClick={() => onChange({ photoKey: null })}
          >
            Remove
          </button>
        ) : null}
      </div>

      {error ? <p className={styles.photoError}>{error}</p> : null}

      <p
        style={{
          margin: '10px 0 0',
          fontSize: 12,
          color: 'var(--text-muted)',
          maxWidth: 200,
        }}
      >
        {uploaded
          ? 'Uploaded. This is what the roster and the public listings will show.'
          : 'JPEG, PNG, WebP or AVIF, up to 10 MB. Or paste a URL if you host it elsewhere.'}
      </p>

      <input
        className={inputClassName}
        style={{ marginTop: 12 }}
        placeholder="https://… photo URL"
        data-field="photoUrl"
        value={photoUrl ?? ''}
        onChange={(e) => onChange({ photoUrl: e.target.value || null })}
        onBlur={onBlurUrl}
        aria-invalid={urlInvalid}
        aria-label="Photo URL, if the agency hosts it elsewhere"
      />
    </div>
  );
}
