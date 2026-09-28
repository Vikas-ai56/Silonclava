/**
 * Credential-vault facade over the shared AEAD in `src/privacy/aead.mjs`.
 *
 * The implementation moved so that non-credential callers (the Phase 3C
 * transcript store) can encrypt at rest without importing this directory.
 * This module keeps the vault's own vocabulary and public API unchanged.
 */
export {
  validateMasterKey as validateVaultMasterKey,
  assertMasterKey as assertVaultMasterKey,
  isEncryptedEnvelope as isEncryptedVaultEnvelope,
  encryptValue as encryptVaultValue,
  decryptValue as decryptVaultValue,
} from '../../privacy/aead.mjs';
