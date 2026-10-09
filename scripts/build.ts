import { copyFile, mkdir, lstat, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { renderVersionedShell } from "../src/web/version.ts";

/** Build only known artifacts; never recursively delete an operator-supplied directory. */
async function main(): Promise<void> {
  const root = resolve(import.meta.dir, "..");
  const output = resolve(process.argv[2] ?? join(root, "dist"));
  if (output !== join(root, "dist") && !(output.startsWith(resolve(tmpdir()) + sep) && basename(output).startsWith("web-build-"))) throw new Error("build_output_unsafe");
  await mkdir(output, { recursive: true });
  if ((await lstat(output)).isSymbolicLink()) throw new Error("build_output_symlink");
  const result = await Bun.build({ entrypoints: [join(root, "src/main.ts"), join(root, "src/web/server.ts")], outdir: output, target: "bun", naming: "[name].js" });
  if (!result.success) throw new Error("build_failed");
  const web = join(output, "web"); await mkdir(web, { recursive: true });
  if ((await lstat(web)).isSymbolicLink()) throw new Error("build_assets_symlink");
  for (const file of ["index.html", "app.js", "app.css", "favicon.svg", "apple-touch-icon.png"]) await copyFile(join(root, "src/web/public", file), join(web, file));
  const htmlPath = join(web, "index.html");
  await writeFile(htmlPath, renderVersionedShell(await readFile(htmlPath, "utf8")));
  process.stdout.write("Sea-Bridge server and Web assets built.\n");
}

main().catch(() => { process.stderr.write("Sea-Bridge build failed.\n"); process.exitCode = 1; });
