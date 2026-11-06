#!/usr/bin/env node
/**
 * Deploy the committed HEAD to a Docker host over SSH and rebuild/restart Muny.
 *
 *   pnpm deploy:nas        # reads MUNY_DEPLOY_* from .env (git-ignored)
 *
 * Env:
 *   MUNY_DEPLOY_HOST  ssh target, e.g. user@192.168.1.10 (required)
 *   MUNY_DEPLOY_PATH  folder on the host containing compose.yaml (default: /volume1/docker/muny)
 *   MUNY_DEPLOY_SSH   ssh binary (default: Windows OpenSSH on win32 so ssh-agent works, else "ssh")
 *   MUNY_DEPLOY_DOCKER docker binary on the host (default: /usr/local/bin/docker for Synology)
 *
 * Only committed files are shipped (git archive), so local data, .env and
 * build output never leave this machine. The host keeps its own compose.yaml,
 * .env (MUNY_SECRET_KEY) and data/ folder; see guides/install.md.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const host = process.env.MUNY_DEPLOY_HOST;
if (!host) {
  console.error("Set MUNY_DEPLOY_HOST (e.g. in .env) to the ssh target, like user@192.168.1.10");
  process.exit(1);
}
const path = process.env.MUNY_DEPLOY_PATH ?? "/volume1/docker/muny";
const docker = process.env.MUNY_DEPLOY_DOCKER ?? "/usr/local/bin/docker";
const winSsh = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const ssh =
  process.env.MUNY_DEPLOY_SSH ??
  (process.platform === "win32" && existsSync(winSsh) ? winSsh : "ssh");

if (!/^[\w@.-]+$/.test(host) || !/^[\w/.-]+$/.test(path)) {
  console.error("Refusing suspicious MUNY_DEPLOY_HOST / MUNY_DEPLOY_PATH");
  process.exit(1);
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { stdio: "inherit", ...opts });
  if (r.status !== 0) {
    console.error(`\n✖ ${cmd} ${args.join(" ")} failed (exit ${r.status})`);
    process.exit(r.status ?? 1);
  }
}

// 1. Warn about uncommitted changes (they won't be deployed).
const dirty = spawnSync("git", ["status", "--porcelain"], { encoding: "utf8" }).stdout.trim();
if (dirty) console.warn("⚠ Uncommitted changes are NOT deployed (only HEAD is shipped).\n");
const rev = spawnSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).stdout.trim();
console.log(`→ Deploying ${rev} to ${host}:${path}`);

// 2. Stream `git archive HEAD` into a fresh src folder on the host.
await new Promise((resolve, reject) => {
  const remote = `set -e; cd ${path}; rm -rf src.new; mkdir src.new; tar -x -C src.new; rm -rf src; mv src.new src`;
  const archive = spawn("git", ["archive", "--format=tar", "HEAD"], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const upload = spawn(ssh, ["-o", "BatchMode=yes", host, remote], {
    stdio: ["pipe", "inherit", "inherit"],
  });
  archive.stdout.pipe(upload.stdin);
  upload.on("exit", (code) => (code === 0 ? resolve() : reject(new Error(`upload exit ${code}`))));
  archive.on("error", reject);
  upload.on("error", reject);
}).catch((err) => {
  console.error(`✖ ${err.message}`);
  process.exit(1);
});
console.log("✔ Source uploaded");

// 3. Build, restart and wait for the healthcheck.
const remote = [
  "set -e",
  `cd ${path}`,
  `${docker} compose build`,
  `${docker} compose up -d`,
  `for i in $(seq 1 45); do s=$(${docker} inspect -f '{{.State.Health.Status}}' muny); [ "$s" = healthy ] && break; sleep 2; done`,
  `echo "health: $s"`,
  `${docker} image prune -f >/dev/null`,
  `[ "$s" = healthy ]`,
].join("; ");
run(ssh, ["-o", "BatchMode=yes", host, remote]);
console.log(`✔ Muny ${rev} is running`);
