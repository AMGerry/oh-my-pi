# swarm_schedule

> Run recurring prompts in a swarm member's native conversation.

## Source

- Tool: `packages/coding-agent/src/swarm/tools/swarm-schedule.ts`
- Prompt: `packages/coding-agent/src/prompts/tools/swarm-schedule.md`
- Scheduler: `packages/coding-agent/src/swarm/scheduler.ts`
- Cron: `packages/coding-agent/src/swarm/cron.ts`
- Native session integration: `packages/coding-agent/src/swarm/runtime.ts`

## Arguments

| Action | Required fields | Result |
| --- | --- | --- |
| `create` | `cron`, `prompt` | `id`, `task`, `boardUri` |
| `list` | — | `tasks`, `boardUri` |
| `kill` | `id` | `id`, `boardUri` |

`create` also accepts `daemon` (default `false`). Cron uses five fields—minute, hour, day of month, month, weekday—in local time. For example, `*/3 * * * *` runs every three minutes. Lists, ranges and positive steps select values within each field.

## Behavior

The process-global swarm runtime owns one scheduler deadline. A due task prompts its owner through the native session lifecycle. A parked conversation revives, and a conversation inside `swarm_wait` receives a steering prompt. The next tick is eligible after that turn ends or parks on the board again. Overlapping ticks and ticks for a busy owner are skipped. Missed deadlines advance directly to the next future occurrence.

A daemon turn stays in the background of the conversation UI; deliberate user input promotes it to foreground work. Tasks are listed with `id`, `swarmId`, `agentId`, `owner`, `cron`, `prompt`, `daemon`, `nextFire`, `running` and any `error`. The coordinator sees the swarm's tasks; other members see their own.

Stopping a task removes its future firings. A tick in progress keeps running when the owner stops its own schedule (a monitor going dormant kills its cron mid-tick and then parks on the board); the coordinator's kill of another member's task cancels that tick. Until the tick ends, the owner's other schedules wait for it. Killing a member stops that member's tasks and their ticks. Schedules end with the process; a resumed monitor creates its schedule again.

## Errors

Invalid cron, a blank prompt, an unknown task id and stopping another member's task as a worker return `isError:true`. Unexpected failures raise `ToolError`. Every result includes `boardUri`.
