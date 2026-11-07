// Runtime configuration, read once from the environment. Fails fast on weak secrets.
import { resolve } from 'node:path';

export interface Config {
  port: number;
  host: string;
  dataDir: string;
  adminToken: string;
  secret: string;
  publicUrl: string;
  retentionDays: number;
  maxBodyBytes: number;
  trustProxy: boolean;
  allowHttpUpstream: boolean;
  telegramApi: string;
  bootstrap: {
    anthropicKey?: string;
    anthropicBaseUrl: string;
    openaiKey?: string;
    openaiBaseUrl: string;
  };
}

export class ConfigError extends Error {}

function num(env: NodeJS.ProcessEnv, name: string, fallback: number, min: number, max: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < min || n > max) throw new ConfigError(`${name} must be a number between ${min} and ${max}`);
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const adminToken = env.LEASH_ADMIN_TOKEN ?? '';
  const secret = env.LEASH_SECRET ?? '';
  if (adminToken.length < 24) throw new ConfigError('LEASH_ADMIN_TOKEN must be set and at least 24 characters (try: openssl rand -hex 24)');
  if (secret.length < 32) throw new ConfigError('LEASH_SECRET must be set and at least 32 characters (try: openssl rand -hex 32)');
  if (adminToken === secret) throw new ConfigError('LEASH_ADMIN_TOKEN and LEASH_SECRET must be different');

  const port = num(env, 'PORT', 8080, 1, 65535);
  const publicUrl = (env.LEASH_PUBLIC_URL || `http://localhost:${port}`).replace(/\/+$/, '');
  if (!/^https?:\/\//.test(publicUrl)) throw new ConfigError('LEASH_PUBLIC_URL must start with http:// or https://');

  return {
    port,
    host: env.HOST || '0.0.0.0',
    dataDir: resolve(env.LEASH_DATA_DIR || './data'),
    adminToken,
    secret,
    publicUrl,
    retentionDays: num(env, 'LEASH_RETENTION_DAYS', 30, 1, 3650),
    maxBodyBytes: num(env, 'LEASH_MAX_BODY_MB', 32, 1, 256) * 1024 * 1024,
    trustProxy: env.LEASH_TRUST_PROXY === '1' || env.LEASH_TRUST_PROXY === 'true',
    allowHttpUpstream: env.LEASH_ALLOW_HTTP_UPSTREAM === '1',
    telegramApi: (env.LEASH_TELEGRAM_API || 'https://api.telegram.org').replace(/\/+$/, ''),
    bootstrap: {
      anthropicKey: env.LEASH_ANTHROPIC_KEY || undefined,
      anthropicBaseUrl: (env.LEASH_ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/+$/, ''),
      openaiKey: env.LEASH_OPENAI_KEY || undefined,
      openaiBaseUrl: (env.LEASH_OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
    },
  };
}
