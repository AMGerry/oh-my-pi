Manage recurring turns for your swarm conversation.

- `create`: require `cron` and `prompt`; `daemon` defaults to false. Five cron fields use local time and minute resolution, e.g. `*/3 * * * *`. Returns `id`, `task` and `boardUri`.
- Each firing delivers the prompt through the owner's native session. A board-waiting owner resumes for the tick. A busy owner or an overlapping tick is skipped. A turn completes when the owner ends its run or parks in `swarm_wait` again.
- `daemon:true` keeps the scheduled turn in the background of the conversation UI. Deliberate user input promotes that turn to foreground work.
- `list`: returns your tasks, or the whole swarm's tasks for its coordinator: `id`, `owner`, `cron`, `prompt`, `daemon`, `nextFire`, `running` and any `error`.
- `kill`: require `id`; removes the schedule. Stopping your own schedule from inside its tick lets that turn go on, so you can kill your cron and then park with `swarm_wait`. The coordinator's kill of another member's task also cancels a tick in progress. An unknown id is a refusal. The owner and coordinator may stop a task; killing a member stops its tasks too.
- Tasks live for this process. After a restart, create the schedule again. Keep the returned id to stop it when the work is finished.
