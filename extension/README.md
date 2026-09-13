# Decipher — Plain-Language Agent Explainer

Decipher adds a **Decipher** icon to the Cursor activity bar. Open it and you get a live, plain-English timeline of everything the agent is doing in the current chat — plus a **Learn & improve** tab that explains the concepts behind that work and suggests tools which could get you a better result with less effort.

## What you see

- **Summary strip** — one sentence describing what the agent is doing right now (or did last turn).
- **Activity timeline** — one card per action ("Checked which files changed", "Saved a checkpoint called …", "Uploaded to GitHub"). Each card has a *Learn more* accordion with what happened, why it matters, the raw technical detail, glossary terms, and concept tags.
- **Learn & improve tab** — what you asked for in your own words, the concepts this chat touched, learning resources grouped by how you consume them (watch / courses / docs / read), and tool suggestions tied to your goal. Export the whole thing as Markdown.
- **Concept detail** — open any concept tag for a plain summary, where it showed up in your files, what helps to know first, an ordered study path, and links grouped by type.
- **Loading state** — while the timeline, summaries, and suggestions are being built, the panel shows a looping animation and a rotating phrase. When hooks are installed, the phrase riffs on the model you are actually chatting with.
- **Plain / Hints / Full** toggle — hides or shows the underlying commands and file paths.

## How it works

1. **Transcripts** — the extension watches `~/.cursor/projects/<workspace>/agent-transcripts/**.jsonl`, which Cursor writes for every chat. This gives every tool call and its input.
2. **Hooks (optional, recommended)** — a small companion Cursor plugin captures what transcripts lack: command output, edit diffs, durations, failures, and the active model. The sidebar prompts you to install it with one click (it copies to `~/.cursor/plugins/local/decipher-hooks`). Events are written locally to `~/.cursor/projects/<workspace>/decipher/events/`. Nothing leaves your machine.
3. **Explanation engine** — ~60 rule-based templates cover git, search, file reads/edits, package managers, dev servers, and Cursor's built-in tools. Optionally the editor's language model summarises complex multi-tool turns.
4. **Learning catalog** — a concept detector reads imports, API symbols, package installs, file types, MCP namespaces, and skill reads; a curated catalog (`knowledge/concepts.json`, ~57 concepts) supplies prerequisites, an ordered study path, and resources tagged `official`, `tutorial`, `video`, `course`, `workshop`, or `skill`.
5. **Improvement research** — after each agent turn, Decipher matches your request and detected concepts against a curated catalog (`recommendations/catalog.json`), optionally searches the live web through Context.dev, and asks the language model to merge both into plain-English suggestions. Results are cached per turn in `~/.cursor/projects/<workspace>/decipher/research/`.

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
npm run dogfood -- --workspace /path/to/project [--id <conversationId>] [--grep "text"] [--json]
```

`dogfood` runs the full pipeline (parse → merge hook events → explain → detect concepts → curated recommendations) against real transcripts and prints the timeline and coverage numbers without launching the editor. It runs offline: no language model, no web search.

## Commands

| Command | Purpose |
| --- | --- |
| `Decipher: Open activity explainer` | Focus the sidebar. |
| `Decipher: Refresh from transcripts` | Re-read the transcript and hook events. |
| `Decipher: Install Cursor hooks` | Copy the companion plugin into `~/.cursor/plugins/local`. |
| `Decipher: Refresh tool suggestions` | Discard the cached research for this chat and look again. |
| `Decipher: Set Context.dev API key` | Store (or clear) the key that enables live web search. |
| `Decipher: Export resource sheet` | Open a Markdown summary of concepts, resources, and suggestions. |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `decipher.mode` | `beginner` | `beginner` hides commands behind *Learn more*; `intermediate` shows a one-line hint; `advanced` shows the full command. |
| `decipher.llm.enabled` | `true` | Use the editor's language model to summarise complex turns. |
| `decipher.llm.alwaysExplainInDepth` | `false` | Ask the model to rewrite every turn summary, not just complex ones. |
| `decipher.cursorProjectsDir` | `""` | Override the Cursor projects directory. |
| `decipher.research.enabled` | `true` | Suggest tools, MCP servers, and kits for what you asked for. |
| `decipher.research.webSearch` | `true` | Search the live web via Context.dev. Needs an API key. |
| `decipher.research.trigger` | `auto` | `auto` refreshes after each agent turn; `manual` waits for you to ask. |
| `decipher.research.maxResults` | `6` | Cap on visible tool suggestions. |
| `decipher.loading.rotateMs` | `3500` | How often the loading phrase changes. |

## Privacy

Hook payloads are redacted before they are written (`Authorization` headers, tokens, `*_KEY=` env vars, password flags). Contents of `.env` and key files are never displayed.

Two features send data off your machine, both off by default until you opt in:

- **LLM summaries and recommendations** use the editor's built-in language model. Only redacted step summaries, short command fragments, and your request text are sent — never file contents.
- **Live web search** sends a short query derived from your request to Context.dev. Absolute paths, path fragments, and credential-shaped tokens are stripped first, and the query is capped at 200 characters. Your Context.dev API key is held in the editor's secret storage — never in settings JSON, the workspace, or the webview. Clear it any time by running *Decipher: Set Context.dev API key* and submitting a blank value.
