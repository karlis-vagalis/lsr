import { resolve } from "node:path";
import type { SourcePlugin } from "./plugin";

/**
 * Holds every registered source plugin. Core components receive a registry
 * instead of knowing concrete plugin types, so adding a plugin never touches
 * the core.
 */
export class PluginRegistry {
	private byId = new Map<string, SourcePlugin>();

	register(plugin: SourcePlugin): void {
		if (this.byId.has(plugin.id)) {
			throw new Error(`plugin "${plugin.id}" is already registered`);
		}
		this.byId.set(plugin.id, plugin);
	}

	get(id: string): SourcePlugin {
		const plugin = this.byId.get(id);
		if (!plugin) throw new Error(`unknown plugin "${id}"`);
		return plugin;
	}

	has(id: string): boolean {
		return this.byId.has(id);
	}

	all(): SourcePlugin[] {
		return [...this.byId.values()];
	}
}

/**
 * Load every bundled plugin under `plugins/<id>/index.ts` and register them
 * all by default. A plugin is the module's default export. Plugins that fail
 * to load are reported and skipped so one broken plugin can't take down core.
 */
export async function loadDefaultRegistry(): Promise<PluginRegistry> {
	const registry = new PluginRegistry();
	const root = resolve(import.meta.dir, "..");
	const glob = new Bun.Glob("plugins/*/index.ts");
	const failures: string[] = [];
	for (const rel of glob.scanSync({ cwd: root, onlyFiles: true })) {
		const id = rel.split("/")[1];
		try {
			const mod = await import(resolve(root, rel));
			const plugin = (mod.default ?? mod.plugin) as SourcePlugin | undefined;
			if (!plugin || typeof plugin.id !== "string" || !plugin.config) {
				throw new Error("module does not export a SourcePlugin");
			}
			registry.register(plugin);
		} catch (err) {
			failures.push(`${id}: ${(err as Error).message}`);
		}
	}
	for (const f of failures) console.error(`[plugins] failed to load ${f}`);
	return registry;
}
