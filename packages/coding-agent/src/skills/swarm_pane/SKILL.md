---
name: swarm_pane
description: >-
  What the coordinator writes so the swarm board overlay's Overview can show the swarm's
  goal, its groups of work and a screenshot timeline. Load it before you brief
  and add the first workers to a swarm.
disable-slash-command: true
---

# The swarm board overlay's Overview

The swarm board overlay builds its Overview from the board and roster. Two small things
from you make it read well: a plan file, and screenshots your workers flag.

Add a narrator when `swarm{action:"status"}` reports `capabilities.narrator`.
Until the narrator publishes a view.json, this Overview is built from the board,
the roster and your plan file.

## Write the plan

Once the workers are added, write
`<artifacts>/swarm/plan.json` (`dir` in `swarm{action:"status"}` plus
`/plan.json`):

```json
{"goal": {"title": "Fix Hub split pane layouts", "line": "Audit, fix, then verify in both themes."},
 "tasks": {"auditor": "Audit split panes across states", "fixer": "Put split panes in one card"},
 "threads": [{"id": "t-split", "title": "Split pane cards", "goal": "Panes share one card with clean headers.",
              "tasks": ["auditor", "fixer"]}]}
```

-   `goal.title` is 4 to 8 words and `goal.line` at most 12.
-   `tasks` names each worker's piece in a few words.
-   `threads` are 1 to 6 groups by the outcome they deliver, never by agent,
    and every worker sits in one.
-   Rewrite the file when you add workers, move work, or the goal changes;
    nothing else. Status, blockers and asks come from the board, so never put
    them here.

## Screenshots for the timeline

When the user asked for a change they can see (UI, layout, visuals), tell each
worker who takes screenshots, in its brief, to flag the ones that show a step
on its own line of the post:

```
Screenshot: <absolute path> | what changed, at most 10 words
```

-   Save them under the worker's own session artifacts
    folder; the UI shows nothing from anywhere else.
-   Same screen, size and theme each time, full window, no crops or diffs.
-   Skip this for backend, infra, data or docs work.
