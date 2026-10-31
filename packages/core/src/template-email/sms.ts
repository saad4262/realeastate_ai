/**
 * SMS templates (ADR 0074, part 1). Pure: the console's editor, the review screen and the send use the
 * same counts. Nothing here sends; it only says what a text will be and what it costs in SMS parts.
 */

/** Added by the app to every marketing text, and counted — nobody can remove it (Spam Act: a working opt-out). */
export const SMS_STOP_FOOTER = 'Reply STOP to opt out';
/** The template's own words, before the footer: three parts' worth of GSM-7. */
export const SMS_TEMPLATE_MAX = 480;

/** The text as it is sent: the person's words, a line break, the footer. */
export function withStopFooter(text: string): string {
  return `${text.trimEnd()}\n${SMS_STOP_FOOTER}`;
}

// GSM 03.38: the basic set (one septet each) and the extension set (two: an escape, then the character).
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
const GSM_EXTENDED = new Set('^{}\\[~]|€\f');

export type SmsParts = {
  /** How many SMS the carrier bills for this text. */
  parts: number;
  /** `gsm7`: 160 in one part, 153 per part when split. `ucs2` (an emoji, a curly quote, most accents): 70, then 67. */
  encoding: 'gsm7' | 'ucs2';
  /** In the encoding's own units: septets for GSM-7 (an extension character is two), UTF-16 code units for UCS-2. */
  units: number;
};

export function smsParts(text: string): SmsParts {
  let septets = 0;
  let gsm = true;
  for (const ch of text) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXTENDED.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return { encoding: 'gsm7', units: septets, parts: septets === 0 ? 0 : septets <= 160 ? 1 : Math.ceil(septets / 153) };
  const units = text.length;
  return { encoding: 'ucs2', units, parts: units <= 70 ? 1 : Math.ceil(units / 67) };
}
