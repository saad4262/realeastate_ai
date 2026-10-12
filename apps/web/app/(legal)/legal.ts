/**
 * The facts both legal pages state about the business. Every value in square
 * brackets is a placeholder to be replaced before the Zoom Marketplace
 * submission and before real customers (docs/DEPLOY.md) — and the text of
 * both pages wants a lawyer's read; it is a starting draft, not advice.
 */
export const LEGAL = {
  siteName: 'Property Platform',
  company: '[Company legal name] (ABN [00 000 000 000])',
  address: '[Street address, Suburb NSW 2000, Australia]',
  privacyEmail: '[privacy@your-domain.com.au]',
  supportEmail: '[support@your-domain.com.au]',
  effective: '[1 November 2026]',
  governingState: '[New South Wales]',
} as const;
