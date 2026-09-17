import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const dryRun = process.argv.includes("--dry-run");
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hookBridge = join(repoRoot, "scripts", "codex-hook-bridge.py");
const codexHome = resolve(process.env.CODEX_HOME ?? join(homedir(), ".codex"));
const hooksPath = join(codexHome, "hooks.json");

const eventTimeouts: Record<string, number> = {
  SessionStart: 5,
  UserPromptSubmit: 5,
  PreToolUse: 5,
  PostToolUse: 5,
  PermissionRequest: 35,
  Stop: 5,
  Interrupt: 5,
};

function loadDocument(): any {
  if (!existsSync(hooksPath)) return { hooks: {} };
  const parsed = JSON.parse(readFileSync(hooksPath, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error(`${hooksPath} must contain a JSON object`);
  if (parsed.hooks === undefined) parsed.hooks = {};
  if (!parsed.hooks || typeof parsed.hooks !== "object" || Array.isArray(parsed.hooks)) throw new Error(`${hooksPath}: hooks must be an object`);
  return parsed;
}

function bridgeCommand(): string {
  const escaped = hookBridge.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
  return `python3 "${escaped}"`;
}

function isSeaBridgeEntry(entry: any): boolean {
  const hooks = Array.isArray(entry?.hooks) ? entry.hooks : [];
  return hooks.some((hook: any) => typeof hook?.command === "string" && hook.command.includes("codex-hook-bridge.py"));
}

const document = loadDocument();
for (const [eventName, timeout] of Object.entries(eventTimeouts)) {
  const list = Array.isArray(document.hooks[eventName]) ? document.hooks[eventName] : [];
  const filtered = list.filter((entry: any) => !isSeaBridgeEntry(entry));
  filtered.push({
    matcher: "",
    hooks: [{
      type: "command",
      command: bridgeCommand(),
      timeout,
      statusMessage: eventName === "PermissionRequest" ? "Waiting for Sea-Bridge remote approval" : `Sea-Bridge ${eventName}`,
    }],
  });
  document.hooks[eventName] = filtered;
}

const output = `${JSON.stringify(document, null, 2)}\n`;
if (dryRun) {
  process.stdout.write(output);
  process.exit(0);
}

mkdirSync(codexHome, { recursive: true, mode: 0o700 });
if (existsSync(hooksPath)) {
  const backup = `${hooksPath}.sea-bridge-backup-${new Date().toISOString().replaceAll(":", "-")}`;
  copyFileSync(hooksPath, backup);
  console.log(`Backup: ${backup}`);
}
writeFileSync(hooksPath, output, { mode: 0o600 });
console.log(`Updated: ${hooksPath}`);
console.log("Verify the hooks feature flag for the installed Codex version before restarting Desktop.");
