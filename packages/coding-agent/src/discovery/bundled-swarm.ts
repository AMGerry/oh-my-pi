import { registerProvider } from "../capability";
import { skillCapability } from "../capability/skill";
import { BUNDLED_SWARM_PROVIDER_ID, loadBundledSwarmSkills } from "../swarm/skills";

registerProvider(skillCapability.id, {
	id: BUNDLED_SWARM_PROVIDER_ID,
	displayName: "Bundled swarm",
	description: "Native swarm coordinator, monitor, narrator and overview skills",
	priority: 10,
	load: loadBundledSwarmSkills,
});
