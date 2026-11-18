# swarm_read

> Read the shared swarm board by cursor, or list the swarm's members.

## Source

- Entry: `packages/coding-agent/src/swarm/tools/swarm-read.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/swarm-read.md`
- Roster formatter: `packages/coding-agent/src/swarm/format.ts`
- Shared binding and failure mapping: `packages/coding-agent/src/swarm/tools/board-tool.ts`
- Board selection and cursors: `packages/coding-agent/src/swarm/runtime.ts`, `packages/coding-agent/src/swarm/board-store.ts`

## Input and availability

| Field | Type | Meaning |
| --- | --- | --- |
| `since` | integer ≥ 0, optional | Read posts after this `seq`; defaults to the caller's own cursor |
| `limit` | integer 1–2000, optional | Page size; defaults to 200 |
| `channel` | channel name or `*`, optional | One channel (`main` included), or every channel for coordinator, narrator and monitor |
| `status` | boolean, optional | `true` returns the roster table; `false` or omitted reads messages |

`swarm_read` is an essential, strict, read-approved tool, available while `swarm.enabled` is on. Unknown arguments are rejected by the schema. `status:true` returns the roster whatever else is passed; `since`, `limit` and `channel` shape message reads only.

## Behavior

- The default view is `main` plus the caller's subscribed channels, plus every post that names the caller. Coordinator, narrator and monitor see all channels.
- A read moves only the caller's cursor, to the highest `seq` it returned; the cursor only moves forward. A page of exactly `limit` messages means more follow: continue with `since` set to the highest `seq` seen.
- `status:true` takes the swarm snapshot from the runtime and renders a Markdown roster: the swarm title, id, `boardUri`, head, directory and enabled capabilities, then one table row per member with role, state, wake trigger (`mentions` or `any post` after a cursor), read cursor, unread count, last post, model, channels, workspace and notes such as a quota error. The caller's row carries `(you)`. Every cursor stays where it is.

## Result

Message reads return the JSON of `{ messages, lastReadSeq, head, boardUri }`; each message has `seq`, `agent`, `text`, `time`, `channel?`, `mentions` and `all` with its full text. Roster reads return the Markdown above.

`details` has the shape `{ boardUri, status, result?, snapshot?, error? }`: `result` holds a message read, `snapshot` the complete swarm snapshot of a roster read. Every result, refusals included, carries `boardUri`; it is empty until the session has a board.

## Errors

Expected refusals (an all-channel read by a worker, an unknown member) return `isError: true` with `{ error, boardUri }` as text. Unexpected failures raise `ToolError`; an abort raises the usual abort error.
