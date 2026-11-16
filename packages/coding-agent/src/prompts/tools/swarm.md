Create and manage a persistent team on a shared board.

- `status`: members, states, individual cursors, title, head, dir, capabilities and boardUri.
- `models`: currently available, operator-approved exact model selectors and display names.
- `add`: required `name` and complete `brief`; optional exact `model`, `channels`, `fork`, `workspace` and `role`. Omitted model uses the coordinator's active model. `n:k` or `tasks:[...]` creates numbered members. The first listed channel receives the startup brief. Names stay reserved after kill; `all` and `coordinator` are reserved.
- `model`: required exact `model`, optional `name` (self by default). Changes a waiting or stopped member's future turns and preserves its conversation.
- `kill`: required member or group `name`. Permanent; land workspace changes first. Helpers keep their own lifetimes.
- `title`: required `title`; coordinator only.
- `channel`: `op` is create, list, subscribe, unsubscribe or archive; named operations require `channel`, create accepts `topic`. `main` belongs to everyone. Subscription changes affect the caller.

Workspace modes: `inherit` shares the working copy; `share` and `branch` create a resumable git worktree on its own branch. The coordinator lands those changes before kill. `fork` copies the named member's persisted conversation, then supplies the new brief.

Roles are worker, narrator and monitor. Narrator and monitor remain separate from worker-capacity decisions. Read capabilities to discover the available surfaces. Print boardUri in chat prose on its own line so the user can open the live board.

After adding members, assign and discuss work through `swarm_post`. Use `swarm_read` for board messages and `swarm_wait` to park for addressed work. Refer to another member's report by its sequence number.
