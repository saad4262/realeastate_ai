# 0096: Managed Twilio numbers check Twilio's signature; the subaccount's Auth Token is kept

**Status:** accepted 2026-11-20 (PLATFORM-PLAN 3.10, migration 0105). This revises ADR 0090, where the token was used
once and dropped.

- **Kept, encrypted.** When the platform makes a subaccount, its Auth Token is now stored in
  `phone_account.auth_token`. It is AES-GCM under INTEGRATION_TOKEN_KEY (ADR 0020), with AAD
  `<id>:twilio_auth_token`.
- **Checked on every webhook to a managed number.** `X-Twilio-Signature` must match, as well as the URL token.
  - A leaked URL alone no longer lets anyone post fake texts or calls into an agency's CRM.
  - The signature is checked against both the URL the request arrived on and the URL we gave Twilio
    (PHONE_WEBHOOK_BASE).
  - A managed account with no stored token, or a token this server cannot decrypt, is refused (fail closed).
    No managed accounts existed when this shipped.
- **BYO numbers keep the URL token only.** The signature needs the account's primary Auth Token. We do not hold an
  agency's own Auth Token, and should not.
- **Rotation (`phone:rotate-auth-tokens`).** A secondary token is made and stored as `auth_token_next`, then promoted,
  then stored as the token.
  - The webhooks accept either token, so there is no gap.
  - A run that stops part-way is picked up on the next run: Twilio is asked which stored token still works.
  - Every value is re-written under the current key, so the same command moves the tokens after a key rotation.
- **URL tokens through a key rotation.** A token made with INTEGRATION_TOKEN_KEY_PREVIOUS is still accepted until
  `phone:repoint` gives every number a URL under the new key.
