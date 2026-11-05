#!/usr/bin/env node
/**
 * Set settings in the NAS's .env and restart Muny so they take effect.
 *
 *   pnpm nas:env plaid             # asks for PLAID_CLIENT_ID, PLAID_SECRET, PLAID_ENV
 *   pnpm nas:env PLAID_REDIRECT_URI MUNY_SYNC_INTERVAL_HOURS
 *
 * Values are typed here (secrets are hidden), sent to the host over SSH stdin
 * (never on a command line), and never printed. Leave an answer empty to keep
 * the current value. Uses the same MUNY_DEPLOY_* settings as deploy.mjs.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";

const host = process.env.MUNY_DEPLOY_HOST;
const path = process.env.MUNY_DEPLOY_PATH ?? "/volume1/docker/muny";
const docker = process.env.MUNY_DEPLOY_DOCKER ?? "/usr/local/bin/docker";
const winSsh = "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
const ssh =
  process.env.MUNY_DEPLOY_SSH ??
  (process.platform === "win32" && existsSync(winSsh) ? winSsh : "ssh");

if (!host || !/^[\w@.-]+$/.test(host) || !/^[\w/.-]+$/.test(path)) {
  console.error("Set MUNY_DEPLOY_HOST (and optionally MUNY_DEPLOY_PATH) in .env first.");
  process.exit(1);
}

const PRESETS = {
  plaid: [
    { name: "PLAID_CLIENT_ID", help: "Plaid dashboard → Developers → Keys → client_id" },
    { name: "PLAID_SECRET", help: "the secret for the environment below (Sandbox or Production)" },
    { name: "PLAID_ENV", help: "sandbox or production", choices: ["sandbox", "production"] },
  ],
};

const args = process.argv.slice(2);
if (!args.length) {
  console.error("Usage: pnpm nas:env plaid   or   pnpm nas:env NAME [NAME...]");
  process.exit(1);
}
const fields = args.flatMap((a) => PRESETS[a.toLowerCase()] ?? [{ name: a }]);
for (const f of fields) {
  if (!/^[A-Z][A-Z0-9_]*$/.test(f.name)) {
    console.error(`"${f.name}" isn't a setting name (use UPPER_CASE, or a preset: plaid).`);
    process.exit(1);
  }
}
const isSecret = (name) => /SECRET|KEY|TOKEN|PASSWORD/.test(name);

function sshRun(remote, input) {
  const r = spawnSync(ssh, ["-o", "BatchMode=yes", host, remote], {
    input,
    encoding: "utf8",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "inherit"],
  });
  if (r.status !== 0) {
    console.error(`✖ ssh to ${host} failed (exit ${r.status})`);
    process.exit(1);
  }
  return r.stdout;
}

/** Prompt for a line; when hidden, echo nothing. */
function ask(question, hidden) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      // Swallow echoed characters while the user types.
      rl._writeToOutput = (s) => {
        if (s.includes(question)) process.stdout.write(question);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write("\n");
      resolve(answer.trim());
    });
  });
}

// 1. Read the current .env (kept in memory only; never printed).
const current = sshRun(`cat ${path}/.env 2>/dev/null || true`);
const lines = current.split(/\r?\n/);
const has = (name) => lines.some((l) => l.startsWith(`${name}=`));

// 2. Ask.
console.log(`Settings for Muny on ${host} (press Enter to keep the current value)\n`);
const updates = {};
for (const f of fields) {
  if (f.help) console.log(`  ${f.name}: ${f.help}`);
  const state = has(f.name) ? "set, Enter keeps it" : "not set";
  for (;;) {
    const v = await ask(
      `  ${f.name} (${state}${isSecret(f.name) ? ", hidden" : ""}): `,
      isSecret(f.name),
    );
    if (!v) break;
    if (/[\s"'`$\\#]/.test(v)) {
      console.log("    That has spaces or special characters; please re-check and paste it again.");
      continue;
    }
    if (f.choices && !f.choices.includes(v)) {
      console.log(`    Use one of: ${f.choices.join(", ")}`);
      continue;
    }
    updates[f.name] = v;
    break;
  }
}
if (!Object.keys(updates).length) {
  console.log("\nNothing changed.");
  process.exit(0);
}

// 3. Merge and write back (owner-only), then recreate the container.
const out = lines.filter((l, i) => !(i === lines.length - 1 && l === ""));
for (const [k, v] of Object.entries(updates)) {
  const i = out.findIndex((l) => l.startsWith(`${k}=`));
  if (i >= 0) out[i] = `${k}=${v}`;
  else out.push(`${k}=${v}`);
}
sshRun(
  `set -e; cd ${path}; [ -f .env ] && cp -p .env .env.bak; umask 077; cat > .env.new; mv .env.new .env; chmod 600 .env .env.bak 2>/dev/null || true`,
  `${out.join("\n")}\n`,
);
console.log(`\n✔ Saved ${Object.keys(updates).join(", ")} (previous file kept as .env.bak)`);

console.log("→ Restarting Muny so it reads the new settings…");
// Names are validated UPPER_CASE above; only "set"/"not set" is reported, never a value.
const checks = fields.map(
  (f) =>
    `if ${docker} exec muny sh -c 'test -n "$${f.name}"'; then echo "${f.name}: set"; else echo "${f.name}: not set"; fi`,
);
const status = sshRun(
  [
    "set -e",
    `cd ${path}`,
    `${docker} compose up -d --force-recreate >/dev/null 2>&1`,
    `for i in $(seq 1 45); do s=$(${docker} inspect -f '{{.State.Health.Status}}' muny); [ "$s" = healthy ] && break; sleep 2; done`,
    `echo "health: $s"`,
    ...checks,
  ].join("; "),
);
console.log(status.trim().replace(/^/gm, "  "));
console.log(
  /health: healthy/.test(status)
    ? "✔ Muny is running"
    : "✖ Muny isn't healthy; check the container logs",
);
