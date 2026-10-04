import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { migrateWeb } from "../src/web/migrations.ts";
import { WebStore } from "../src/web/store.ts";
import { WebAuth } from "../src/web/auth.ts";
import { WebControlServer } from "../src/web/control-server.ts";
import { LOGIN_FIXTURE } from "./helpers/web-login.ts";

/** Exercise hidden terminal input without installing credentials into a real service. */
const TERMINAL_DRIVER = `
import os,pty,select,subprocess,sys,time,json,termios
master,slave=pty.openpty()
p=subprocess.Popen([sys.argv[1],sys.argv[2],"account"],stdin=slave,stdout=slave,stderr=slave)
steps=[("账号（", "fixture-admin\\r"),("密码（", "fixture-password-only\\r"),("再次输入密码：", "fixture-password-only\\r" if sys.argv[3]=="success" else "mismatch-fixture\\r")]
output=""; step=0; deadline=time.monotonic()+5
while time.monotonic()<deadline:
    if select.select([master],[],[],0.05)[0]:
        output+=os.read(master,4096).decode("utf8")
    if step<len(steps) and steps[step][0] in output:
        os.write(master,steps[step][1].encode()); step+=1
    if p.poll() is not None: break
if p.poll() is None: p.kill()
p.wait()
restored=bool(termios.tcgetattr(slave)[3] & termios.ECHO)
os.close(master); os.close(slave)
print(json.dumps({"code":p.returncode,"output":output,"restored":restored}))
`;

test("account CLI hides passwords, checks confirmation and restores terminal echo", async () => {
  const root = mkdtempSync(join(tmpdir(), "web-account-cli-"));
  const db = new Database(":memory:"); migrateWeb(db);
  const store = new WebStore(db); const auth = new WebAuth(store);
  const path = join(root, "control.sock"); const server = new WebControlServer(path, auth);
  try {
    await server.start();
    for (const mode of ["mismatch", "success"]) {
      const process = Bun.spawn(["python3", "-c", TERMINAL_DRIVER, Bun.which("bun") ?? "bun", resolve("scripts/web-control.ts"), mode], {
        env: { ...Bun.env, SEA_BRIDGE_WEB_CONTROL_SOCKET: path }, stdout: "pipe", stderr: "pipe",
      });
      const output = await new Response(process.stdout).text();
      expect(await process.exited).toBe(0);
      const result = JSON.parse(output) as { code: number; output: string; restored: boolean };
      expect(result.code).toBe(mode === "success" ? 0 : 1);
      expect(result.output).not.toContain(LOGIN_FIXTURE.password);
      expect(result.output).not.toContain("mismatch-fixture");
      expect(result.restored).toBe(true);
      expect(auth.accountConfigured()).toBe(mode === "success");
    }
    expect(await auth.login(LOGIN_FIXTURE.username, LOGIN_FIXTURE.password, "local", "fixture")).not.toBeNull();
  } finally { await server.stop(); db.close(); rmSync(root, { recursive: true, force: true }); }
}, 10000);

test("account CLI rejects non-terminal input and command-line credentials", async () => {
  const process = Bun.spawn(["bun", "scripts/web-control.ts", "account", "do-not-accept-password-argument"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  expect(await process.exited).toBe(1);
  expect(await new Response(process.stderr).text()).not.toContain("do-not-accept-password-argument");
});
