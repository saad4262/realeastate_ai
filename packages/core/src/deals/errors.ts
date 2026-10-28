/** The deal pipeline's refusals (ADR 0063, 0064), in their own file so every deal module can throw them. */
export class DealError extends Error {
  constructor(
    public readonly code: 'forbidden' | 'not_found' | 'invalid' | 'conflict',
    message: string,
  ) {
    super(message);
    this.name = 'DealError';
  }
}
