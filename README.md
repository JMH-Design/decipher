# Decipher

**Plain-language explanations of what the Cursor agent did, the concepts behind it, and the tools that could help you do it better.**

Decipher adds a sidebar to Cursor (activity bar icon, like Claude Code) that turns agent transcripts into a live timeline anyone can read. Every step gets a plain-English summary, glossary terms, and optional technical detail. Alongside it, a **Learn & improve** tab shows the concepts the agent used with videos, courses, and workshops for each — and suggests tools, MCP servers, and kits that could get you the same result with less effort.

Built for non-technical users who want to understand *what happened*, *what to study next*, and *what to reach for next time*.

## Features

- **Live activity timeline** — reads, edits, searches, git, package installs, and more, explained step by step
- **Learn more** on every card — what happened, why it matters, glossary, and concept tags
- **Learn & improve tab** — the concepts in this chat, merged learning resources (official docs, videos, courses, workshops), and tool suggestions tied to what you asked for
- **Improvement research** — a curated catalog plus live web search and the editor's language model, refreshed after each agent turn
- **Turn recap** — a distinct box under the timeline with a headline of what the turn amounted to and a paragraph explaining it
- **Hybrid explanations** — ~60 rule-based templates for common actions; an LLM-written recap for each finished turn when a model is available
- **Branded loading state** — the cards build behind a looping SVG and a rotating phrase that riffs on the model you are chatting with, then dissolve into view once the turn is done
- **Cursor hooks plugin** — captures command output, diffs, durations, and the active model that transcripts alone don't include (local only, redacted)

## Repository layout

```
extension/         VS Code / Cursor extension (React webview sidebar)
plugin/            Cursor hooks plugin (ships inside the extension bundle)
shared/            TypeScript types shared across extension + plugin
glossary/          ~100 plain-language term definitions
knowledge/         ~57 curated concepts with prerequisites, topics, resources
recommendations/   Curated tool / MCP / kit catalog with match rules
```

## Quick start

```bash
npm install
npm run install:cursor   # build, package, install into Cursor
```

Reload Cursor (`Developer: Reload Window`), click the **Decipher** icon in the activity bar, and accept the hooks install banner for richer explanations.

To enable live web search for tool suggestions, run **Decipher: Set Context.dev API key** from the command palette (or press *Set up web search* in the Learn & improve tab). Without a key, suggestions come from the built-in catalog and the language model.

See [`extension/README.md`](extension/README.md) for settings, development commands, and privacy details. Product requirements: [`docs/PRD.md`](docs/PRD.md).

## Development

```bash
npm run watch              # rebuild on change
npm test                   # vitest (82 tests)
npm run typecheck
npm run dogfood -- --workspace /path/to/project [--id <conversationId>]
```

## How it works

1. **Transcripts** — watches `~/.cursor/projects/<workspace>/agent-transcripts/*.jsonl`
2. **Hooks** — optional plugin writes to `~/.cursor/projects/<workspace>/decipher/events/`
3. **Pipeline** — parse → merge hooks → template engine → glossary → concept detection → learning resources → research → webview

The cards are built as the agent works, but stay behind a single loader until the turn is over and the recap and tool suggestions have landed — so the panel is revealed finished rather than filling in piecemeal.

Nothing leaves your machine unless you turn on LLM summaries (the editor's built-in language model, redacted input) or live web search (a short, path-stripped query sent to Context.dev).

## License

MIT — see [LICENSE](LICENSE).
