# swarm_post

> Append a message to the shared swarm board and ring the members it names.

## Source

- Entry: `packages/coding-agent/src/swarm/tools/swarm-post.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/swarm-post.md`
- Shared binding and failure mapping: `packages/coding-agent/src/swarm/tools/board-tool.ts`
- Board append and delivery: `packages/coding-agent/src/swarm/runtime.ts`, `packages/coding-agent/src/swarm/board-store.ts`
- Mention parsing: `packages/coding-agent/src/swarm/mentions.ts`

## Input and availability

| Field | Type | Meaning |
| --- | --- | --- |
| `text` | non-empty string | The complete message |
| `channel` | member-name-shaped string, optional | Destination channel; defaults to the caller's first subscribed channel, otherwise `main` |

`swarm_post` is an essential, strict, exec-approved tool. It is available while `swarm.enabled` is on, to the coordinator and to every swarm member. Unknown arguments are rejected by the schema.

## Behavior

- The runtime binds the calling session to its swarm (`getSwarmCaller`, `ensure`), appends `{seq, agent, text, time, channel?, mentions, all}` to `board.jsonl` and syncs it before any member is rung. `seq` grows by one per post.
- `@name`, `@all` and `@#channel` at a word start address members, case-insensitively and over whole names. A numbered group name addresses every member of the group. `@all` covers `main`, so `@#main` is refused.
- Only addressed live members other than the author are rung. A post that names nobody is stored and wakes nobody; a post that names its author, by `@name`, `@all` or a `@#channel`, rings every other addressed member. Delivery goes through the native IRC bus: a member parked in `swarm_wait` is resolved directly, a stopped member is revived, an idle member is woken with a turn and a working member gets a doorbell at its next step boundary.
- The doorbell carries the post's `seq` and the recipient's read cursor (`[swarm] board moved: #<seq>; swarm_read{since:<cursor>}`); the post body stays on the board. Busy recipients receive the notice at a step boundary and publish responses through `swarm_post`. Direct IRC exchanges retain their own reply state.
- Empty or whitespace-only text, `@#main`, an unknown or archived channel, a worker's post to a channel it is not subscribed to and a killed caller are refused.

## Result

The text content is the JSON of the result: `post`, `receipts`, `head`, `lastReadSeq` and `boardUri`. Each receipt names the member (`name`, `to`) and its `outcome` (`injected`, `woken`, `revived` or `failed`, with `error` when delivery failed); a killed member's receipt reports that it is killed.

`details` has the shape `{ boardUri, result?, error? }`. Every result, refusals included, carries `boardUri`; it is empty until the session has a board.

## Errors

Expected refusals return `isError: true` with `{ error, boardUri }` as text. Unexpected failures raise `ToolError`. An abort before the post is made raises the usual abort error; a committed post is always reported.
