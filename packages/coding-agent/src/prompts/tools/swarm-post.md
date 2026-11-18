Append a message to the swarm board and ring the members it names.

- `text`: the complete message. Name who should act at the start of a word: `@name` reaches a member (a numbered group such as `@parse` reaches `parse-1..k`), `@all` reaches every member, `@#channel` reaches that channel's subscribers from any channel. `@all` covers `main`; `@#main` is refused. Matching is case-insensitive and follows whole names.
- `channel`: optional destination. It defaults to your first subscribed channel, otherwise `main`.
- A post that names nobody is stored for later reads and rings nobody. Every `@mention` rings its addressee and costs it a turn, so name the peers who act next; tag `@coordinator` for the final deliverable (open with `[done]` after the mention), a blocker or a decision.
- Refer to earlier posts by sequence number (`#4`). Readers fetch the body with `swarm_read`.
- Result: `post` (`seq`, `agent`, `text`, `time`, `channel`, `mentions`, `all`), `receipts` (`name`, `to`, `outcome` of `injected`, `woken`, `revived` or `failed`, plus `error`), `head`, `lastReadSeq` and `boardUri`. A killed member's receipt reports that it is killed.
- Refused: empty or whitespace-only text, `@#main`, an unknown or archived channel, and a worker's post to a channel it is not subscribed to.
