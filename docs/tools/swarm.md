# swarm

> Manage a persistent team through a shared, ordered board.

## Source

- Entry: `packages/coding-agent/src/swarm/tools/swarm.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/swarm.md`
- Control and board ownership: `packages/coding-agent/src/swarm/runtime.ts`
- Durable records: `packages/coding-agent/src/swarm/board-store.ts`
- Native task launch: `TaskTool.prepareSwarmMember` and the structured-subagent executor
- Worker-thread bridge: `packages/coding-agent/src/thread/services/swarm.ts`
- Working copies: `packages/coding-agent/src/swarm/workspaces.ts`, using native VCS worktrees

## Inputs

| action | Fields | Result |
| --- | --- | --- |
| `status` | — | Roster, individual cursors, title, head, directory and capabilities |
| `models` | — | Available, operator-approved exact model selectors and names |
| `add` | `name`, `brief`; optional `model`, `channels`, `n`, `tasks`, `fork`, `workspace`, `role` | New members and complete roster |
| `model` | `model`; optional `name` (self) | Updated model for self or an idle member |
| `kill` | `name` | Permanently killed member or numbered group |
| `title` | `title` | Coordinator-owned swarm title |
| `channel` | `op`; named operations take `channel`, creation accepts `topic`, subscribe and unsubscribe accept `name` | Channel definitions and subscriptions |

Every result carries `boardUri`, which can be printed in chat prose as a clickable `swarm://` link. Status and additions include capabilities for channels, workspaces, narrator, monitor, graph and custom page.

Names use lowercase letters, digits and hyphens, starting with a letter, up to 40 characters. `all` and `coordinator` are reserved. Killed names remain reserved. `n` and `tasks` create `<name>-1..k`; group mentions and kills use the base name.

An omitted model uses the coordinator's active model, including for helpers created by another member. Swarm model selection follows `swarm.enabled`; task/eval selection follows `task.perCallModel`. Exact selections pass the native model resolver and operator-grant policy, including the live coordinator's model grant. A successful switch persists in the same conversation and applies after park/revive. A member may switch its own model during its turn; another member must be waiting or stopped. Quota failures retain the member with `error:"quota"` and state `waiting`; posts that name it still wake it. A model switch clears that error and retries the failed turn on the new model.

The coordinator may kill, switch or move any member. Every other member may kill the helpers it added, and switch or move itself and the helpers it added.

## Startup and lifetime

A member is an ordinary native subagent with an additional board record. Its complete brief is posted on the board and supplied as the first native assignment. Its cursor starts after the group's startup briefs. A fork seeds a separate conversation from the selected member's persisted history.

`inherit` uses the caller's working copy. `share` and `branch` give the member a native Git worktree on `swarm/<id>/<name>`, starting from the caller's working copy as it stands, uncommitted changes included. Landing precedes deletion: cleanup verifies a clean checkout and landed content. A retained branch reference is reported when Git still protects its commits.

Kill first checks every targeted workspace: a working copy with open changes or an unlanded branch refuses the kill and leaves the whole group running. Kill then disposes the native session, persists its tombstone and removes the owned workspace; `retainedBranches` lists branches kept for a cherry-picked landing, and `retainedWorkspaces` lists working copies that changed while their member stopped. Helpers retain their independent lifetimes. After a restart, surviving member records restore as stopped native registrations with their saved conversations and cursors.

## Channels and roles

`main` is shared by every member. `create`, `list`, `subscribe`, `unsubscribe` and `archive` manage named channels. Subscribe and unsubscribe move `name`, a member or numbered group, and the caller when `name` is omitted; the first subscription receives its default posts and startup brief. A helper added by a member joins that member's active channels unless `channels` is given. An explicit channel read can inspect earlier channel history. Coordinator, narrator and monitor have all-channel visibility.

Roles are `worker`, `coordinator`, `narrator` and `monitor`. Narrator and monitor names, including numbered replacements, select those helper roles by default. Their role-specific brief identifies the corresponding skill.

## Settings

`swarm.enabled` activates the tool family. `swarm.maxMembers` bounds active workers and helpers, defaults to 32, and accepts 1–256. Both settings appear in the Tasks / Swarm settings group.
