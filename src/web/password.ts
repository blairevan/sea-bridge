/** Fixed Argon2id costs keep stored credentials and verification resource bounds predictable. */
export const PASSWORD_OPTIONS = { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 } as const;

/** Validate bounded administrator names without silently changing their identity. */
export function validUsername(username: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9_.-]{2,63}$/.test(username);
}

/** Require the operator to choose a password; no generated or default credential exists. */
export function validPassword(password: string): boolean {
  return password.length >= 12 && password.length <= 256 && Boolean(password.trim()) && !/[\u0000-\u001f\u007f]/.test(password);
}

/** Accept only hashes emitted by the local account command with the fixed cost profile. */
export function validPasswordHash(hash: string): boolean {
  return /^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{43}\$[A-Za-z0-9+/]{43}$/.test(hash);
}
