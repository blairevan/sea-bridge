import type { WebAuth } from "../../src/web/auth.ts";

/** Synthetic test credential, never used by an installed service. */
export const LOGIN_FIXTURE = { username: "fixture-admin", password: "fixture-password-only" };
export const LOGIN_HASH = await Bun.password.hash(LOGIN_FIXTURE.password, { algorithm: "argon2id", memoryCost: 19456, timeCost: 2 });

/** Initialize isolated credentials and issue a browser session through real verification. */
export async function loginFixture(auth: WebAuth, name = "fixture") {
  if (!auth.accountConfigured()) auth.setAccount(LOGIN_FIXTURE.username, LOGIN_HASH);
  const session = await auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "local", name);
  if (!session) throw new Error("fixture login failed");
  return session;
}
