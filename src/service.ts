import { execSync } from "node:child_process";
import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

export type Scope = "user" | "system";

function run(cmd: string, opts?: { check?: boolean }): string {
	try {
		return execSync(cmd, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
	} catch (err) {
		if (opts?.check === false) return "";
		const e = err as { stderr?: string; message: string };
		throw new Error(`${cmd} failed: ${(e.stderr ?? e.message).trim()}`);
	}
}

function scopeFlag(scope: Scope): string {
	return scope === "user" ? "--user" : "";
}

/** Where user-level unit files live (facilitates creating the dir). */
function unitDir(scope: Scope): string {
	return scope === "user"
		? join(homedir(), ".config", "systemd", "user")
		: "/etc/systemd/system";
}

function unitPath(scope: Scope): string {
	return join(unitDir(scope), "lsr.service");
}

/** Resolve the absolute bun interpreter + entry file, independent of cwd. */
function runtime(): { bun: string; entry: string } {
	const bun = process.execPath; // we always run under Bun
	const entry = resolve(import.meta.dir, "cli.ts");
	return { bun, entry };
}

export function unitBody(opts: { scope: Scope; config: string }): string {
	const { bun, entry } = runtime();
	const runAs = opts.scope === "system" ? `User=${run("whoami").trim()}\n` : "";
	return `[Unit]
Description=lsr local semantic search daemon (EmbeddingGemma 2)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
${runAs}Environment=LSR_CONFIG=${opts.config}
ExecStart=${bun} ${entry} serve
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=full

[Install]
WantedBy=${opts.scope === "user" ? "default.target" : "multi-user.target"}
`;
}

/** Write the unit, reload, then enable + start. */
export function installService(opts: { scope: Scope; config: string }): void {
	const path = unitPath(opts.scope);
	mkdirSync(unitDir(opts.scope), { recursive: true });
	writeFileSync(path, unitBody(opts), "utf8");
	const flag = scopeFlag(opts.scope);
	run(`systemctl ${flag} daemon-reload`);
	run(`systemctl ${flag} enable --now lsr.service`);
	console.log(`installed lsr.service (${opts.scope}) -> ${path}`);
	console.log(
		`  config     : ${opts.config}\n  systemctl ${flag} status lsr.service`,
	);
}

export function uninstallService(scope: Scope): void {
	const path = unitPath(scope);
	const flag = scopeFlag(scope);
	run(`systemctl ${flag} disable --now lsr.service`, { check: false });
	if (existsSync(path)) unlinkSync(path);
	run(`systemctl ${flag} daemon-reload`, { check: false });
	console.log(`uninstalled lsr.service (${scope})`);
}

export function serviceStatus(scope: Scope): void {
	const flag = scopeFlag(scope);
	const out = run(`systemctl ${flag} status lsr.service --no-pager`, {
		check: false,
	});
	console.log(out.trim() || `lsr.service not present (${scope})`);
}

export function describeService(scope: Scope): string {
	const path = unitPath(scope);
	return `lsr.service (${scope}) ${existsSync(path) ? "installed" : "not installed"} -> ${path}`;
}
