# Lumen — Plain-Language Agent Explainer

Lumen adds a **Lumen** icon to the activity bar of Cursor and VS Code. Open it and you get a live, plain-English timeline of everything your coding agent is doing in the current chat — plus a **Learn & improve** tab that explains the concepts behind that work and suggests tools which could get you a better result with less effort.

## Supported agents

| Editor | Agent | Where Lumen reads it |
| --- | --- | --- |
| Cursor | Cursor agent | `~/.cursor/projects/<workspace>/agent-transcripts/` |
| VS Code, VS Code Insiders | GitHub Copilot Chat, agent mode | `<user data>/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/` |
| Cursor or VS Code | Claude Code | `~/.claude/projects/<encoded-workspace-path>/` |

`lumen.dataSource` is `auto` by default: the editor's own agent first, then Claude Code, which can run in either. Set it explicitly to pin one source. Pre-rename `decipher.*` settings still work.

Hooks are a Cursor plugin, so command output, edit diffs, and exit codes are Cursor-only. Copilot's transcript records tool durations and pass/fail; Claude Code's records tool results. Everywhere else the timeline is built from tool names and inputs alone, and the hooks banner stays hidden rather than asking for something that cannot be installed.

## What you see

- **Activity timeline** — one card per action ("Checked which files changed", "Saved a checkpoint called …", "Uploaded to GitHub"). Each card has a *Learn more* accordion with what happened, why it matters, the raw technical detail, glossary terms, and concept tags.
- **Turn recap** — docked under the timeline: a headline of what the turn amounted to ("Read 18 files, edited 3 files, and ran 2 commands.") and a paragraph explaining what was asked, what happened, and how it ended.
- **Learn & improve tab** — what you asked for in your own words, the concepts this chat touched, learning resources grouped by how you consume them (watch / courses / docs / read), and tool suggestions tied to your goal. Export the whole thing as Markdown.
- **Concept detail** — open any concept tag for a plain summary, where it showed up in your files, what helps to know first, an ordered study path, and links grouped by type.
- **Loading state** — the cards are built behind a looping animation and a rotating phrase, and stay hidden until the agent's turn is over and the recap and suggestions have landed. The overlay then dissolves over 300ms to reveal a finished panel. When hooks are installed, the phrase riffs on the model you are actually chatting with.
- **Plain / Hints / Full** toggle — hides or shows the underlying commands and file paths.

## How it works

1. **Transcripts** — a host adapter locates the agent's own log and normalises it. Each agent writes a different format (Cursor's Anthropic-style messages, Copilot's typed event stream, Claude Code's message records with interleaved subagent work), and every adapter produces the same steps and turns, so nothing downstream knows which editor it is in.
2. **Hooks (optional, Cursor only)** — a small companion Cursor plugin captures what transcripts lack: command output, edit diffs, durations, failures, and the active model. The sidebar prompts you to install it with one click (it copies to `~/.cursor/plugins/local/lumen-hooks`). Events are written locally to `~/.cursor/projects/<workspace>/lumen/events/`. Lumen still reads the pre-rename `decipher/events/` directory if present. Nothing leaves your machine. In VS Code, Lumen keeps its own cache under the extension's global storage instead.
3. **Explanation engine** — ~60 rule-based templates cover git, search, file reads/edits, package managers, dev servers, and the agents' built-in tools. Each adapter maps its agent's tool names and argument keys onto one canonical set, so Copilot's `read_file` and Claude's `Read` hit the same template. When the editor's language model is available it writes the recap for each finished turn; otherwise the recap is composed from the templates.
4. **Learning catalog** — a concept detector reads imports, API symbols, package installs, file types, MCP namespaces, and skill reads; a curated catalog (`knowledge/concepts.json`, ~57 concepts) supplies prerequisites, an ordered study path, and resources tagged `official`, `tutorial`, `video`, `course`, `workshop`, or `skill`.
5. **Improvement research** — after each agent turn, Lumen matches your request and detected concepts against a curated catalog (`recommendations/catalog.json`), optionally searches the live web through Context.dev, and asks the language model to merge both into plain-English suggestions. Results are cached per turn next to the agent's data in Cursor, and under the extension's global storage elsewhere.

## Install

From the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=JMH-Design.lumen-explainer) or [Open VSX](https://open-vsx.org/extension/JMH-Design/lumen-explainer), or from source:

```bash
npm install
npm run install:cursor      # builds, packages and installs into Cursor
npm run install:vscode      # ...or into VS Code
```

Then reload the editor (`Developer: Reload Window`) and click the Lumen icon in the activity bar.

## Develop

```bash
npm run watch               # rebuild on change
npm test                    # vitest unit tests
npm run typecheck
npm run dogfood -- --workspace /path/to/project [--source copilot|claude-code|cursor] [--id <conversationId>] [--grep "text"] [--json]
npm run dogfood -- --file path/to/transcript.jsonl --format claude-code
npm run icon                # re-render media/icon.png from media/icon-marketplace.svg
```

`dogfood` runs the full pipeline (parse → merge hook events → explain → detect concepts → curated recommendations) against real transcripts and prints the timeline and coverage numbers without launching the editor. It runs offline: no language model, no web search. `--source` picks the agent; `--file` with `--format` explains one transcript directly, which is the quickest way to check a new adapter.

### Adding an agent

Two files and one line of registration:

1. A store in `src/host/transcriptStore.ts` that knows where the agent keeps its transcripts, which directories to watch, and whether hooks are available.
2. A parser in `src/parser/adapters/` that turns that agent's records into `ParsedTranscript`, plus a tool-name map so its tools land on the existing templates.
3. Register the format in `src/parser/adapters/index.ts` and the provider in `candidateProviders()`.

Nothing downstream of `TranscriptStore` needs to change.

## Release

```bash
npm run package             # lumen-<version>.vsix
npm run publish:marketplace # needs VSCE_PAT (Azure DevOps, Marketplace → Manage scope)
npm run publish:openvsx     # needs OVSX_PAT
```

Pushing a `v*` tag runs [`.github/workflows/release.yml`](../.github/workflows/release.yml), which tests, packages, attaches the VSIX to a GitHub release, and publishes to whichever registries have a token in repository secrets.

## Commands

| Command | Purpose |
| --- | --- |
| `Lumen: Open activity explainer` | Focus the sidebar. |
| `Lumen: Refresh from transcripts` | Re-read the transcript and hook events. |
| `Lumen: Install Cursor hooks` | Copy the companion plugin into `~/.cursor/plugins/local`. Cursor only. |
| `Lumen: Refresh tool suggestions` | Discard the cached research for this chat and look again. |
| `Lumen: Set Context.dev API key` | Store (or clear) the key that enables live web search. |
| `Lumen: Export resource sheet` | Open a Markdown summary of concepts, resources, and suggestions. |

## Settings

| Setting | Default | Meaning |
| --- | --- | --- |
| `lumen.mode` | `beginner` | `beginner` hides commands behind *Learn more*; `intermediate` shows a one-line hint; `advanced` shows the full command. |
| `lumen.dataSource` | `auto` | Which agent to explain: `auto`, `cursor`, `copilot`, or `claude-code`. |
| `lumen.llm.enabled` | `true` | Use the editor's language model to write the recap for each finished turn. |
| `lumen.llm.alwaysExplainInDepth` | `false` | Also recap turns where the agent took no actions and only replied. |
| `lumen.projectsDirOverride` | `""` | Override the Cursor projects directory. Replaces `lumen.cursorProjectsDir`, which still works. |
| `lumen.claudeConfigDir` | `""` | Override the Claude Code config directory. Defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude`. |
| `lumen.research.enabled` | `true` | Suggest tools, MCP servers, and kits for what you asked for. |
| `lumen.research.webSearch` | `true` | Search the live web via Context.dev. Needs an API key. |
| `lumen.research.trigger` | `auto` | `auto` refreshes after each agent turn; `manual` waits for you to ask. |
| `lumen.research.maxResults` | `6` | Cap on visible tool suggestions. |
| `lumen.loading.rotateMs` | `3500` | How often the loading phrase changes. |

## Privacy

Hook payloads are redacted before they are written (`Authorization` headers, tokens, `*_KEY=` env vars, password flags). Contents of `.env` and key files are never displayed.

Two features send data off your machine, both off by default until you opt in:

- **LLM summaries and recommendations** use the editor's built-in language model. Only redacted step summaries, short command fragments, and your request text are sent — never file contents.
- **Live web search** sends a short query derived from your request to Context.dev. Absolute paths, path fragments, and credential-shaped tokens are stripped first, and the query is capped at 200 characters. Your Context.dev API key is held in the editor's secret storage — never in settings JSON, the workspace, or the webview. Clear it any time by running *Lumen: Set Context.dev API key* and submitting a blank value.
