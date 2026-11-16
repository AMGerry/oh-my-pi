import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, isEnoent, parseFrontmatter } from "@oh-my-pi/pi-utils";
import type { Skill } from "../capability/skill";
import type { LoadContext, LoadResult } from "../capability/types";
import { resolveContainedPath } from "../discovery/contained-path";
import swarm from "../skills/swarm/SKILL.md" with { type: "text" };
import logo from "../skills/swarm/logo.svg" with { type: "text" };
import monitor from "../skills/swarm_monitor/SKILL.md" with { type: "text" };
import narrator from "../skills/swarm_narrator/SKILL.md" with { type: "text" };
import pane from "../skills/swarm_pane/SKILL.md" with { type: "text" };
import { writeFileAtomically } from "../utils/atomic-file";

export const BUNDLED_SWARM_PROVIDER_ID = "bundled-swarm";
const definitions: Readonly<Record<string, string>> = {
	swarm,
	swarm_monitor: monitor,
	swarm_narrator: narrator,
	swarm_pane: pane,
};
export const SWARM_SKILL_NAMES: readonly string[] = Object.keys(definitions);
const resources: Readonly<Record<string, string>> = {
	"swarm/SKILL.md": swarm,
	"swarm/logo.svg": logo,
	"swarm_monitor/SKILL.md": monitor,
	"swarm_narrator/SKILL.md": narrator,
	"swarm_pane/SKILL.md": pane,
};
const bundleHash = createHash("sha256").update(JSON.stringify(resources)).digest("hex");

/** Publish the embedded bundle into the profile cache, preserving each build's resource paths. */
export async function loadBundledSwarmSkills(context: LoadContext): Promise<LoadResult<Skill>> {
	const cache = path.join(context.agentDir ?? getAgentDir(), "cache", "bundled-skills");
	await fs.mkdir(cache, { recursive: true });
	const cacheRoot = await fs.realpath(cache);
	const bundle = path.join(cacheRoot, bundleHash);
	await fs.mkdir(bundle, { recursive: true });
	if ((await fs.lstat(bundle)).isSymbolicLink() || (await resolveContainedPath(cacheRoot, bundle)).status !== "ok") {
		throw new Error("Bundled skill cache must be a directory within its profile cache root");
	}
	const root = await fs.realpath(bundle);
	for (const [relativePath, content] of Object.entries(resources)) {
		const destination = path.join(root, relativePath);
		await fs.mkdir(path.dirname(destination), { recursive: true });
		const parent = await resolveContainedPath(root, path.dirname(destination));
		if (parent.status !== "ok" || (await fs.lstat(path.dirname(destination))).isSymbolicLink()) {
			throw new Error(`Bundled skill directory must be a directory within its bundle: ${relativePath}`);
		}
		const canonical = path.join(parent.realPath, path.basename(destination));
		try {
			const existing = await fs.lstat(canonical);
			if (existing.isFile() && (await Bun.file(canonical).text()) === content) continue;
		} catch (error) {
			if (!isEnoent(error)) throw error;
		}
		await writeFileAtomically(canonical, content);
	}
	const items: Skill[] = [];
	for (const [name, content] of Object.entries(definitions)) {
		const filePath = path.join(root, name, "SKILL.md");
		const { frontmatter, body } = parseFrontmatter(content, { source: filePath });
		items.push({
			name,
			path: filePath,
			content: body,
			frontmatter,
			containRoot: await fs.realpath(path.dirname(filePath)),
			level: "user",
			_source: {
				provider: BUNDLED_SWARM_PROVIDER_ID,
				providerName: "Bundled swarm",
				path: filePath,
				level: "native",
			},
		});
	}
	return { items, warnings: [] };
}
