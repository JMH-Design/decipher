# Decipher

**Plain-language explanations of what the Cursor agent did — and what you need to learn from it.**

Decipher adds a sidebar to Cursor (activity bar icon, like Claude Code) that turns agent transcripts into a live timeline anyone can read. Each step gets a plain-English summary, glossary terms, and optional technical detail. A **Knowledge Debt** score tracks concepts the agent used that you haven't learned yet, with topics and resources for each.

Built for non-technical users who want to understand *what happened* and *what to study next*.

## Features

- **Live activity timeline** — reads, edits, searches, git, package installs, and more, explained step by step
- **Learn more** on every card — what happened, why it matters, glossary, and concept tags
- **Knowledge Debt** — novelty × depth × relevance scoring with a prioritised learning queue (max 5)
- **Hybrid explanations** — ~60 rule-based templates for common actions; optional LLM summaries for complex turns
- **Cursor hooks plugin** — captures command output, diffs, and durations that transcripts alone don't include (local only, redacted)

## Repository layout

```
extension/     VS Code / Cursor extension (React webview sidebar)
plugin/        Cursor hooks plugin (ships inside the extension bundle)
shared/        TypeScript types shared across extension + plugin
glossary/      ~100 plain-language term definitions
knowledge/     ~50 curated concepts with prerequisites, topics, resources
```

## Quick start

```bash
npm install
npm run install:cursor   # build, package, install into Cursor
```

Reload Cursor (`Developer: Reload Window`), click the **Decipher** icon in the activity bar, and accept the hooks install banner for richer explanations.

See [`extension/README.md`](extension/README.md) for settings, development commands, and privacy details.

## Development

```bash
npm run watch              # rebuild on change
npm test                   # vitest (40 tests)
npm run typecheck
npm run dogfood -- --workspace /path/to/project [--id <conversationId>]
```

## How it works

1. **Transcripts** — watches `~/.cursor/projects/<workspace>/agent-transcripts/*.jsonl`
2. **Hooks** — optional plugin writes to `~/.cursor/projects/<workspace>/decipher/events/`
3. **Pipeline** — parse → merge hooks → template engine → glossary → concept detection → debt scoring → webview

Nothing leaves your machine unless you enable LLM summaries (uses the editor's built-in language model with redacted input).

## License

MIT — see [LICENSE](LICENSE).
