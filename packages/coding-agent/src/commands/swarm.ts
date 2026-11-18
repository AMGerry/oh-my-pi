/**
 * Inspect persisted swarm boards and run the headless swarm self-test.
 */

import { Args, Command, Flags } from "@oh-my-pi/pi-utils/cli";
import { swarmHelp as commandHelp } from "../cli/command-help";
import { runSwarmCommand, type SwarmCliAction } from "../cli/swarm-cli";

const ACTIONS: SwarmCliAction[] = ["list", "board", "selftest"];

export default class Swarm extends Command {
	static description = commandHelp.description;

	static args = {
		action: Args.string({
			description: "list (default), board, or selftest",
			required: false,
			options: ACTIONS,
		}),
		id: Args.string({
			description: "Swarm id (board)",
			required: false,
		}),
	};

	static flags = {
		all: Flags.boolean({ char: "a", description: "List the boards of every project (list)" }),
		since: Flags.integer({ description: "Show posts after this sequence number (board)" }),
		json: Flags.boolean({ char: "j", description: "Emit machine-readable JSON" }),
	};

	static examples = [
		"omp swarm",
		"omp swarm list --all",
		"omp swarm board swarm-1f0c --since 40",
		"omp swarm selftest",
		"omp swarm selftest --json",
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Swarm);
		const exitCode = await runSwarmCommand(
			{
				action: (args.action ?? "list") as SwarmCliAction,
				id: args.id,
				flags: { all: flags.all ?? false, json: flags.json ?? false, since: flags.since },
			},
			process.cwd(),
		);
		if (exitCode !== 0) process.exitCode = exitCode;
	}
}
