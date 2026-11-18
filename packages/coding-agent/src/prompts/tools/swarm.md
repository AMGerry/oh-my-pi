Create and manage a persistent team on a shared board.

- `status`: members, states, individual cursors, title, head, dir, capabilities and boardUri.
- `models`: currently available, operator-approved exact model selectors and display names.
- `add`: required `name` and complete `brief`; optional exact `model`, `channels`, `fork`, `workspace` and `role`. Omitted model uses the coordinator's active model. `n:k` or `tasks:[...]` creates numbered members. The first listed channel receives the startup brief; a helper added by a member joins that member's active channels unless `channels` is given. Names stay reserved after kill; `all` and `coordinator` are reserved.
- `model`: required exact `model`, optional `name` (self by default). Changes the member's future turns and preserves its conversation; another member must be waiting or stopped. A member whose turn failed on quota retries that turn on the new model. The coordinator switches any member; every other member switches itself and the helpers it added.
- `kill`: required member or group `name`. Permanent; land workspace changes first, since an unlanded workspace refuses the kill and the member keeps running. Helpers keep their own lifetimes. The coordinator kills any member; every other member kills only the helpers it added.
- `title`: required `title`; coordinator only.
- `channel`: `op` is create, list, subscribe, unsubscribe or archive; named operations require `channel`, create accepts `topic`. `main` belongs to everyone. subscribe and unsubscribe move `name` (a member or numbered group; the caller by default): the coordinator moves any member, every other member itself and the helpers it added.

Workspace modes: `inherit` shares the working copy; `share` and `branch` create a resumable git worktree on its own branch, starting from the adder's working copy as it stands, uncommitted changes included. The coordinator lands those changes before kill. `fork` copies the named member's persisted conversation, then supplies the new brief.

Roles are worker, narrator and monitor. Narrator and monitor remain separate from worker-capacity decisions. Read capabilities to discover the available surfaces. Print boardUri in chat prose on its own line so the user can open the live board.

After adding members, assign and discuss work through `swarm_post`. Use `swarm_read` for board messages and `swarm_wait` to park for addressed work. Refer to another member's report by its sequence number.
