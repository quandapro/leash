// Key derivation, encryption at rest (AES-256-GCM), hashing and constant-time comparison.
import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, timingSafeEqual } from 'node:crypto';

export interface Keys {
  enc: Buffer;
  mac: Buffer;
}

export function deriveKeys(secret: string): Keys {
  const salt = Buffer.from('leash-v1');
  return {
    enc: Buffer.from(hkdfSync('sha256', secret, salt, 'leash-encryption', 32)),
    mac: Buffer.from(hkdfSync('sha256', secret, salt, 'leash-mac', 32)),
  };
}

export function encrypt(keys: Keys, plain: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keys.enc, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return 'v1:' + Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64');
}

export function decrypt(keys: Keys, sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown ciphertext version');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const decipher = createDecipheriv('aes-256-gcm', keys.enc, raw.subarray(0, 12));
  decipher.setAuthTag(raw.subarray(12, 28));
  return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8');
}

export function sha256(s: string): string {
  return createHash('sha256').update(s).digest('hex');
}

export function hmac(keys: Keys, s: string): string {
  return createHmac('sha256', keys.mac).update(s).digest('hex');
}

export function randomToken(prefix: string, bytes = 24): string {
  return prefix + randomBytes(bytes).toString('base64url');
}

/** Constant-time string comparison that does not leak length. */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash('sha256').update(a).digest();
  const hb = createHash('sha256').update(b).digest();
  return timingSafeEqual(ha, hb);
}

/** Shows the first and last characters of a secret, never the middle. */
export function mask(secret: string): string {
  if (secret.length <= 10) return '•'.repeat(secret.length);
  return `${secret.slice(0, 6)}…${secret.slice(-4)}`;
}
