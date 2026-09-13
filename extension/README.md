# Decipher — Plain-Language Agent Explainer

Decipher adds a **Decipher** icon to the Cursor activity bar. Open it and you get a live, plain-English timeline of everything the agent is doing in the current chat — plus a **Learn** tab that quantifies your *Knowledge Debt*: the concepts the agent used that you have not learned yet, with ordered topics and resources for each.

## What you see

- **Summary strip** — one sentence describing what the agent is doing right now (or did last turn).
- **Activity timeline** — one card per action ("Checked which files changed", "Saved a checkpoint called …", "Uploaded to GitHub"). Each card has a *Learn more* accordion with what happened, why it matters, the raw technical detail, glossary terms and concept tags.
- **Learn tab** — the session's Knowledge Debt score, a prioritised queue (max 5) of concepts to learn, recurring blind spots, and your progress across sessions. Click a concept for its learning path and mark it as learned.
- **Beginner / Advanced** toggle — hides or shows the underlying commands and file paths.

## How it works

1. **Transcripts** — the extension watches `~/.cursor/projects/<workspace>/agent-transcripts/**.jsonl`, which Cursor writes for every chat. This gives every tool call and its input.
2. **Hooks (optional, recommended)** — a small companion Cursor plugin captures what transcripts lack: command output, edit diffs, durations and failures. The sidebar prompts you to install it with one click (it copies to `~/.cursor/plugins/local/decipher-hooks`). Events are written locally to `~/.cursor/projects/<workspace>/decipher/events/`. Nothing leaves your machine.
3. **Explanation engine** — ~60 rule-based templates cover git, search, file reads/edits, package managers, dev servers, and Cursor's built-in tools. Optionally, the editor's language model summarises complex multi-tool turns (`decipher.llmSummaries`).
4. **Knowledge Debt** — a concept detector reads imports, API symbols, package installs, file types and skill reads; a curated graph (`knowledge/concepts.json`, ~50 concepts) supplies prerequisites, topics and resources; debt = novelty × depth × relevance to your original request. Your learned/learning status persists in `~/.cursor/projects/<workspace>/decipher/profile.json`.

## Install

```bash
npm install
npm run install:cursor      # builds, packages and installs into Cursor
```

Then reload Cursor (`Developer: Reload Window`) and click the Decipher icon in the activity bar.

## Develop

```bash
npm run watch               # rebuild on change
npm test                    # vitest unit tests
npm run typecheck
npm run dogfood -- --workspace /path/to/project [--id <conversationId>] [--request "text"] [--json]
```

`dogfood` runs the full pipeline (parse → merge hook events → explain → detect concepts → score debt) against real transcripts and prints the timeline and coverage numbers without launching the editor.

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decipher.mode` | `beginner` | Hide (`beginner`) or show (`advanced`) commands and paths. |
| `decipher.llmSummaries` | `false` | Use the editor's language model for complex turns. |
| `decipher.showGlossaryHints` | `true` | Show glossary terms under each step. |
| `decipher.knowledgeDebt.enabled` | `true` | Detect concepts and score Knowledge Debt. |
| `decipher.knowledgeDebt.maxQueue` | `5` | Cap on the visible learning queue. |
| `decipher.followLatestConversation` | `true` | Auto-switch to the most recently active chat. |

## Privacy

Hook payloads are redacted before they are written (`Authorization` headers, tokens, `*_KEY=` env vars, password flags). Contents of `.env` and key files are never displayed. Only redacted summaries are sent to the language model, and only when you turn LLM summaries on.
