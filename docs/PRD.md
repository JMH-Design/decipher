# Lumen — Product Requirements Document

**Status:** Shipped (v0.3.1)  
**Version:** 0.3.1  
**Repository:** [github.com/JMH-Design/lumen](https://github.com/JMH-Design/lumen)  
**Last updated:** September 13, 2026

---

## 1. Executive summary

Lumen is an extension for Cursor and VS Code that translates coding-agent activity into plain English and helps users learn from it and do better next time. It sits in the activity bar (like Claude Code) and shows a timeline of every agent action — reads, edits, searches, git operations, package installs — each explained in language a non-technical user can understand.

It functions as both **education** and **improvement**:

- **Education** — detects concepts the agent used (GSAP, React, git, etc.) and surfaces learning resources: official docs, videos, courses, workshops, and local skills.
- **Improvement** — reviews what the user asked for and researches tools, MCP servers, kits, and services that could help them achieve the same goal with more quality or efficiency.

**v0.3.1 changes from v0.3.0:** Product renamed from Decipher to **Lumen** (`JMH-Design.lumen-explainer` on the Marketplace; display name **Lumen — Plain-Language Agent Explainer**). Settings, commands, and on-disk cache paths use the `lumen` prefix; pre-rename `decipher.*` settings and `decipher/events/` hook data are still read.

**v0.3 changes from v0.2:** Lumen is now **multi-host**. Transcript discovery and parsing sit behind per-agent adapters, so the same build explains the Cursor agent, GitHub Copilot Chat in agent mode, and Claude Code. Everything downstream of the adapters — templates, glossary, concepts, research, recap, overlay — is unchanged and host-agnostic. The extension publishes to the VS Code Marketplace and Open VSX.

**v0.2 changes from v0.1:** Knowledge Debt (scoring, queues, learned/seen status, profile persistence) has been removed. The product is now organized around a **Learn & improve** tab, **improvement research** (curated catalog + optional live web search), a **branded loading overlay**, and a **turn recap** docked at the bottom of the sidebar.

**Current release:** Local-only IDE sidebar across Cursor and VS Code, hybrid rule-based step explanations, LLM-written turn recaps when a model is available, ~102 glossary terms, ~57 curated concepts, ~40 recommendation catalog entries, Cursor hooks plugin for richer data capture, 153 unit tests.

---

## 2. Problem statement

When a coding agent works on a task, the chat log is dense: shell commands, file paths, tool names, and jargon. For users with little coding background, this reads like hieroglyphs. They cannot reliably answer:

- *What did the agent just do?*
- *Why did it do that?*
- *What should I learn so I understand it next time?*
- *What tools could help me do this better myself?*

Existing tools show *what* happened at a technical level. Lumen shows *what it means*, *what to study*, and *what to reach for next time*.

---

## 3. Target users

### Primary persona: The curious non-coder

- Uses Cursor or VS Code to build or modify projects with agent help
- Can follow high-level instructions but does not read terminal output fluently
- Wants to learn over time, not stay dependent on the agent
- Example: asks the agent to "add a scroll animation to the homepage hero" and wants to understand GSAP afterward

### Secondary persona: The learning developer

- Has some technical literacy but encounters unfamiliar stacks (Astro, GSAP, MCP tools)
- Wants resources tied to real work, not generic tutorials
- Uses Lumen to discover complementary tools and MCP servers for recurring goals

### Non-target (v0.2)

- Teams needing shared dashboards or manager reporting
- Cloud-agent-only workflows (no local IDE)
- Users who want the agent to do work without any visibility into how
- Users who want spaced-repetition or gamified "debt" tracking (removed in v0.2)

---

## 4. Goals and non-goals

### Goals (v0.3)

| Goal | How Lumen addresses it |
|------|---------------------------|
| Comprehension | Plain-language step cards with title, summary, and expandable detail |
| Turn-level understanding | Bottom **turn recap** with headline + explanatory paragraph after each turn |
| Education | Glossary terms, concept tags, learning resources (docs, videos, courses, workshops) |
| Improvement | Tool/MCP/kit recommendations matched to user goal and detected concepts |
| Calm UX | Full-content **loading overlay** hides a growing timeline until the turn and enrich pass are complete |
| Trust & privacy | All data local by default; redaction before storage/display |
| Low friction | One-click hooks install; auto-follow latest conversation |
| Host neutrality | One build works in Cursor and VS Code; per-agent adapters normalise transcripts so the explanation engine never branches on host |
| Honest degradation | Where a host cannot supply hook data, Lumen says so and hides the install prompt rather than asking for something unavailable |

### Non-goals (v0.3)

- Knowledge Debt scoring, learning queues, blind spots, or profile persistence (removed)
- Cross-conversation history browser
- Canvas / diff drill-down views
- Team sharing, cloud sync, or analytics backend
- External course marketplace integrations
- Replacing the agent chat UI
- Minimum splash on already-finished, cached chats
- Hook-level capture parity outside Cursor (no stable host API yet)
- Explaining non-Copilot chat participants (`@workspace`, custom participants)

---

## 5. Product overview

### 5.1 Supported hosts and agents

| Host | Agent | Transcript location | Timeline + recap | Command output, diffs, exit codes |
|------|-------|---------------------|------------------|-----------------------------------|
| Cursor | Cursor agent | `~/.cursor/projects/<slug>/agent-transcripts/` | Yes | Yes, via the hooks plugin |
| VS Code, VS Code Insiders | GitHub Copilot Chat (agent mode) | `<user data>/workspaceStorage/<hash>/GitHub.copilot-chat/transcripts/` | Yes | Durations and pass/fail only, from the transcript |
| Cursor or VS Code | Claude Code | `~/.claude/projects/<encoded-workspace-path>/` | Yes | Tool results only, from the transcript |

**Host detection:** `vscode.env.appName` resolves to `cursor`, `vscode`, `vscode-insiders`, or `unknown`.

**Source selection (`lumen.dataSource`):**

1. An explicit value (`cursor`, `copilot`, `claude-code`) always wins.
2. `auto` (default) prefers the host's own agent, then falls back to Claude Code, which runs in either host. A candidate is only chosen if its transcripts contain real messages, so a metadata-only Claude session does not shadow a working Copilot one.

**Everything else is host-agnostic.** The LM API (`vscode.lm`), templates, glossary, concept detection, research, recap, and overlay behave identically; in VS Code the model comes from Copilot.

**Prerequisites:** VS Code 1.94+ with GitHub Copilot Chat in agent mode, or the Claude Code extension, or both. The Cursor path needs nothing beyond Cursor itself.

**Lumen-owned storage:** in Cursor, caches live beside the agent's data in `~/.cursor/projects/<slug>/lumen/`. Elsewhere there is no host project directory to borrow, so research and events go under the extension's `globalStorageUri`, keyed by workspace slug.

**Settings:**

| Setting | Default | Behavior |
|---------|---------|----------|
| `lumen.dataSource` | `auto` | `auto`, `cursor`, `copilot`, or `claude-code` |
| `lumen.projectsDirOverride` | `""` | Override the Cursor projects directory |
| `lumen.claudeConfigDir` | `""` | Override the Claude Code config directory; defaults to `$CLAUDE_CONFIG_DIR`, then `~/.claude` |
| `lumen.cursorProjectsDir` | `""` | Deprecated alias for `lumen.projectsDirOverride`; still read for backward compatibility |

### 5.2 Entry point

- **Activity bar icon** — speech bubble + magnifying glass (`Lumen`)
- **Command palette** — `Lumen: Open activity explainer`
- Sidebar webview titled **Agent activity**

### 5.3 Information architecture

```
Lumen sidebar
├── Top bar
│   ├── Conversation picker (chats for this workspace)
│   └── Detail level toggle (Plain / Hints / Full)
├── Tabs
│   ├── What happened (Activity timeline)
│   └── Learn & improve (concepts + resources + tool suggestions)
├── Optional banner: Install Cursor hooks (Cursor only)
├── Optional banner: source note (quiet; e.g. Claude session has no messages yet)
├── Stage (content area below tabs)
│   ├── Timeline or Learn panel (built under overlay while agent works)
│   ├── Turn recap (docked at bottom of stage, above footer)
│   └── Loading overlay (covers stage until ready; 300ms dissolve)
└── Footer (workspace name, action count, Refresh)
```

**Removed in v0.2:** top summary strip, Learn tab with debt badge, debt queue, blind spots, progress card, export learning plan, reset profile.

---

## 6. Feature requirements (as shipped in v0.3)

### 6.1 Activity timeline

**Description:** Chronological list of agent actions grouped by turn.

| Requirement | Status | Notes |
|-------------|--------|-------|
| Parse Cursor agent transcripts (`.jsonl`) | Shipped | Watches `~/.cursor/projects/<slug>/agent-transcripts/` |
| Parse Copilot Chat transcripts | Shipped | Typed event stream; `chatSessions` delta log as lower-fidelity fallback |
| Parse Claude Code transcripts | Shipped | Message records; `isSidechain` work nests as subagent steps |
| One card per tool invocation | Shipped | Shell, Read, Write, StrReplace, Grep, Task, AskQuestion, CallDynamicTool, etc. |
| Tool names normalised across agents | Shipped | Copilot `read_file` and Claude `Read` both become the canonical `Read`, with argument keys remapped, so one template set covers all three agents |
| Turn grouping with user request | Shipped | Turn index, quoted request, status (active/success/error/aborted) |
| Category icons & color coding | Shipped | 13 categories: reading, searching, editing, running, checking, saving, asking, planning, delegating, external, browsing, thinking, other |
| Windowed rendering | Shipped | Last 60 steps; "Show earlier" loads more |
| Subagent steps | Shipped | Nested under parent Task steps |
| Open file from step | Shipped | When step has a file path |
| Built under overlay during active turn | Shipped | User does not see cards until overlay dissolves |

**Step card content:** title, one-sentence summary, optional error, concept tags (up to 4), meta (live pill, duration, time), **Learn more** accordion (what happened, why it matters, technical detail, glossary, sub-steps for chained commands).

---

### 6.2 Loading overlay

**Description:** Branded loader that covers the timeline area while the agent is working or Lumen is still enriching the session. The user never reads a half-built panel.

| Requirement | Status | Notes |
|-------------|--------|-------|
| Full-content overlay below top bar | Shipped | Conversation picker and tabs stay usable |
| Looping SVG spinner | Shipped | Three concentric arcs ("lock being picked") |
| Rotating witty phrases | Shipped | `"Verb the noun…"` — verbs about understanding, nouns about LLMs |
| Model-aware nouns | Shipped | When hooks report agent model, phrases riff on that model; generic pool otherwise |
| Phase labels | Shipped | boot, working, parsing, research, ready |
| Hold through active turn | Shipped | `working` while last turn status is `active` |
| Hold through enrich | Shipped | `parsing` (LLM recap) and/or `research` (tool suggestions) after turn ends |
| 300ms dissolve | Shipped | Overlay fades out when `ready`; unmounts after fade |
| Cancel fade on new turn | Shipped | New non-ready phase snaps overlay back to visible |
| Reduced motion | Shipped | Instant hide when `prefers-reduced-motion: reduce` |
| No fake splash on cached chats | Shipped | Already-finished turns with cached research go straight to `ready` |
| Hidden until genuinely waiting | Shipped | Overlay starts hidden on `ready`/`boot`; only mounts when phase is `working`, `parsing`, or `research` |
| Restore on sidebar open | Shipped | If Lumen was collapsed while the agent worked, reopening the sidebar re-shows the overlay when phase ≠ `ready` |
| Enrich deferred during active turn | Shipped | LLM recap and research do not start until the agent turn ends (`status !== 'active'`) |

**Loading phases (`loadingPhase`):**

| Phase | When | Stage label |
|-------|------|-------------|
| `boot` | Webview mounted, no session state yet | Starting up |
| `working` | Agent turn still active | Watching the agent work (or "Watching Copilot work" / "Watching Claude work") |
| `parsing` | Turn finished; LLM recap pending | Writing up what happened |
| `research` | Turn finished; tool suggestions pending | Looking for resources and tools |
| `ready` | Nothing outstanding | Overlay dissolves |

**Settings:** `lumen.loading.rotateMs` (default 3500) — phrase rotation interval.

**Implementation:** `resolveLoadingPhase.ts`, `overlayVisibility.ts` (`initialOverlayVisibility`, `nextOverlayVisibility`), `LoadingState.tsx`, `useLoadingOverlay` in webview. Host sends `viewVisible` / `viewHidden` when the sidebar is expanded or collapsed; webview re-shows the overlay on `viewVisible` if enrich is still running.

**Operational note:** After building from source, run `npm run install:cursor` (or `npm run install:vscode`) in `extension/` and **Developer: Reload Window**. Neither host hot-reloads extension UI changes; a stale install will still show the pre-overlay behavior (full-panel replace loader, top summary strip).

---

### 6.3 Turn recap

**Description:** Distinct summary surface docked at the bottom of the stage (above footer). First thing the user sees when the overlay dissolves. Not styled as a timeline card.

| Requirement | Status | Notes |
|-------------|--------|-------|
| Headline | Shipped | Count sentence: "Read 18 files, edited 3 files, and ran 2 commands." (`liveHeadline`) |
| Body paragraph | Shipped | What was asked, what happened, outcome (`liveSummary`) |
| LLM recap for finished turns | Shipped | 3–4 sentences, ~90 words when editor model available |
| Template fallback | Shipped | `composeTurnRecap` — files changed, failures, closing agent note |
| Eyebrow label | Shipped | "This turn" / "Right now" / "Nothing yet" |
| User request line | Shipped | Muted "You asked: …" when available |
| Visual distinction | Shipped | Accent top rule, tinted background, upward shadow — not a step card |
| Error/aborted styling | Shipped | Error color on top rule and eyebrow |
| Hidden during concept drill-down | Shipped | Turn recap not shown when ConceptDetail is open |

**Removed:** top summary strip (`SummaryStrip.tsx`).

**During active turn (under overlay):** recap still updates internally (`liveSummaryKind: 'now'`) with current step title/summary for accessibility; user sees it only after dissolve.

---

### 6.4 Explanation engine

**Description:** Hybrid system that turns raw tool calls into plain language for step cards; separate recap layer for turn summary.

| Requirement | Status | Notes |
|-------------|--------|-------|
| Rule-based templates | Shipped | ~60 patterns: git, ripgrep, npm/pnpm, dev servers, file ops, agent tools (canonical names, shared across hosts) |
| Chained shell decomposition | Shipped | `cmd1 && cmd2` → parent card + sub-steps |
| Output-aware explanations | Shipped | When hooks provide stdout (e.g. git status details) |
| Glossary enrichment | Shipped | ~102 terms with definitions, analogies, aliases |
| Friendly file names | Shipped | "main stylesheet (global.css)" vs raw paths |
| Sensitive file handling | Shipped | `.env`, keys — never show contents |
| LLM turn recap | Shipped | Every finished turn with steps gets a recap when model available |
| LLM opt-in for reply-only turns | Shipped | `lumen.llm.alwaysExplainInDepth` |
| Confidence scoring | Shipped | Template confidence still used for dogfood coverage metrics |

**Template coverage targets (dogfood):**

- ≥80% tool calls explained without LLM at step level
- ≥70% code edits match ≥1 knowledge concept

---

### 6.5 Cursor hooks plugin

**Description:** Companion plugin capturing data transcripts lack. **Cursor only** — no other host exposes an equivalent API.

| Hook event | Captured data |
|------------|---------------|
| `afterShellExecution` | Command, stdout/stderr, duration |
| `postToolUse` / `postToolUseFailure` | Tool output, errors |
| `afterFileEdit` | File path, edit hunks |
| `beforeSubmitPrompt` | User prompt text |
| `sessionStart` | Active agent model (for loading phrases) |
| `stop` / `subagentStop` | Turn completion |

**Storage:** `~/.cursor/projects/<slug>/lumen/events/<conversation_id>.jsonl`

**Install:** Extension copies bundled plugin to `~/.cursor/plugins/local/lumen-hooks`.

**Redaction (before write):** Authorization headers, tokens, `*_KEY=` env vars, password flags; truncation of large outputs.

**Outside Cursor:** the extension sets a `lumen.hooksSupported` context key to `false`, which hides the install banner and disables the `Lumen: Install Cursor hooks` command in the palette. Running it anyway explains the gap instead of failing. Step cards still work from transcripts; what is missing is command output, edit diffs, durations, exit codes, and the agent model used for the witty loading phrases. VS Code has hooks-adjacent APIs in proposal ([`chatParticipantPrivate`](https://github.com/microsoft/vscode/issues/293567)); a VS Code hook installer is a follow-up once those stabilise.

---

### 6.6 Detail levels (Explain modes)

| Mode | User sees |
|------|-----------|
| **Plain** (default) | Summary only; technical detail inside Learn more |
| **Hints** | One-line monospace hint per step |
| **Full** | Full command/path block inline |

Setting: `lumen.mode`

---

### 6.7 Learn & improve tab

**Description:** Combined education + improvement panel. Replaces v0.1 Knowledge Debt tab.

| Element | Description |
|---------|-------------|
| What you asked for | Latest user goal quote + session recap blurb |
| Concepts in this chat | Detected concepts from agent activity, relevance-ordered |
| Learning resources | De-duplicated resources merged across concepts, grouped by type (watch / courses / docs / read) |
| Suggested tools | Recommendations from catalog + LLM + optional web search |
| Concept detail | Drill-down: plain summary, prerequisites, study path, resource links |
| Export resource sheet | Markdown export of goal, recap, concepts, resources, suggestions |

**Concept detection signals:** imports/API symbols, package installs, file extensions, skill reads, MCP namespaces, keywords in user request.

**Knowledge graph:** ~57 curated concepts with prerequisites, ordered topics, resources tagged `official`, `tutorial`, `video`, `course`, `workshop`, or `skill`.

**No debt metrics:** no scoring bars, no learned/seen status, no profile persistence, no blind spots queue.

---

### 6.8 Improvement research

**Description:** After each agent turn completes, match user goal and detected concepts against a curated catalog and optionally search the live web; merge with LLM into plain-English suggestions.

| Requirement | Status | Notes |
|-------------|--------|-------|
| Curated catalog | Shipped | ~40 entries in `recommendations/catalog.json` |
| Match rules | Shipped | By concept id, keyword, package, category |
| Auto trigger | Shipped | Default: refresh after each finished turn |
| Manual trigger | Shipped | `Lumen: Refresh tool suggestions` / button in UI |
| Per-turn cache | Shipped | `~/.cursor/projects/<slug>/lumen/research/` in Cursor; extension global storage elsewhere |
| Live web search | Shipped | Context.dev API; requires stored API key |
| Overlay waits for research | Shipped | `loadingPhase: research` until cache hit or run completes |

**Settings:**

| Setting | Default | Behavior |
|---------|---------|----------|
| `lumen.research.enabled` | `true` | Suggest tools/MCPs/kits |
| `lumen.research.webSearch` | `true` | Search live web via Context.dev |
| `lumen.research.trigger` | `auto` | `auto` after each turn; `manual` on request |
| `lumen.research.maxResults` | `6` | Cap visible suggestions |

---

### 6.9 LLM integration (optional)

| Setting | Default | Behavior |
|---------|---------|----------|
| `lumen.llm.enabled` | `true` | Write turn recap when model available |
| `lumen.llm.alwaysExplainInDepth` | `false` | Also recap reply-only turns (no tool steps) |

Provider: VS Code Language Model API (`vscode.lm`) — Cursor's own models in Cursor, Copilot's in VS Code. Graceful fallback to `composeTurnRecap` when unavailable. Redacted input only — never file contents.

---

### 6.10 Commands

| Command | Action |
|---------|--------|
| Lumen: Open activity explainer | Focus sidebar |
| Lumen: Refresh from transcripts | Force re-parse |
| Lumen: Install Cursor hooks | Copy plugin locally (Cursor only; hidden from the palette elsewhere) |
| Lumen: Refresh tool suggestions | Invalidate research cache and re-run |
| Lumen: Set Context.dev API key | Enable/disable live web search |
| Lumen: Export resource sheet | Save Markdown summary |

**Removed in v0.2:** Export learning plan, Reset learning profile.

---

## 7. User flows

### Flow A: First-time user watches an agent session

1. User starts an agent chat (Cursor agent, Copilot agent mode, or Claude Code)
2. Opens Lumen from activity bar and **keeps it visible** (loader only shows while the sidebar is open or when reopened mid-turn)
3. In Cursor, sees hooks banner → clicks **Install** → reloads. Elsewhere the banner does not appear.
4. While agent works: overlay shows spinner + rotating phrase ("Lumening the black box…") with stage label "Watching the agent work"
5. Agent finishes; overlay stays up while recap and suggestions are written (`parsing` / `research`)
6. Overlay dissolves over 300ms; timeline + bottom turn recap appear together
7. User reads recap headline and paragraph, expands **Learn more** on a step

### Flow B: Learning from an animation task

1. User asks agent to implement GSAP scroll animation
2. Overlay hides timeline until turn completes
3. Turn recap: "Read 4 files, edited 2 files, and ran 2 commands." + explanatory paragraph
4. User switches to **Learn & improve** → sees GSAP concept, video/course links, Rive/Lottie suggestions
5. Clicks GSAP → reads study path, opens local `gsap-core` skill resource
6. Exports resource sheet as Markdown takeaway

### Flow C: Reviewing a finished chat (instant open)

1. User opens Lumen on a chat whose turn already completed and research is cached
2. No overlay delay — panel shows immediately with recap and suggestions
3. User runs **Refresh tool suggestions** to force new research → overlay returns briefly

---

## 8. Technical architecture

```
┌─────────────────────────────────────────────────────────┐
│  Host (Cursor · VS Code · VS Code Insiders)             │
│                                                          │
│  Cursor agent ──▶ agent-transcripts/*.jsonl ─┐          │
│  Copilot Chat ──▶ workspaceStorage/…/*.jsonl ─┤         │
│  Claude Code  ──▶ ~/.claude/projects/…/*.jsonl┤         │
│  Hooks plugin ──▶ lumen/events/*.jsonl ────┤ (Cursor)│
│                                               │          │
│  ┌────────────────────────────────────────────▼───────┐ │
│  │ detectHost → resolveStore (TranscriptStore)        │ │
│  │   CursorStore · CopilotStore · ClaudeStore         │ │
│  │   parserFor(format) → ParsedTranscript             │ │
│  └────────────────────────────┬───────────────────────┘ │
│  ┌────────────────────────────▼───────────────────────┐ │
│  │ Lumen Extension (Node) — host-agnostic          │ │
│  │  Watcher → HookMerger                              │ │
│  │         → TemplateEngine                           │ │
│  │         → ConceptDetector → KnowledgeGraph         │ │
│  │         → resolveLoadingPhase                      │ │
│  │         → LlmSummarizer (async)                    │ │
│  │         → ResearchService (async)                  │ │
│  │         → SessionBuilder → webview postMessage     │ │
│  └────────────────────────────┬───────────────────────┘ │
│  ┌────────────────────────────▼───────────────────────┐ │
│  │ React Webview (sidebar)                            │ │
│  │  App → Timeline | LearnImprovePanel | TurnRecap    │ │
│  │       LoadingOverlay (fade) | ConceptDetail        │ │
│  └────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘

Local files:
  glossary/terms.json
  knowledge/concepts.json
  recommendations/catalog.json
  research/<conversation>.json   (per-turn cache)
  events/<conversation>.jsonl    (hooks; Cursor only)
```

`TranscriptStore` is the single seam. It answers "which conversations exist" and "parse this one", and each implementation owns its own discovery rules, watch directories, `hooksSupported` flag, and cache location. `SessionBuilder` holds a store, not a set of paths, so adding an agent means adding a store plus a parser — no changes downstream.

**Monorepo layout:**

- `extension/` — VS Code extension + React webview
  - `src/host/` — `detectHost`, `transcriptStore`, `copilotPaths`, `claudePaths`
  - `src/parser/adapters/` — one transcript adapter and tool-name map per agent
- `plugin/` — Cursor hooks (bundled into extension dist)
- `shared/` — TypeScript types (`SessionState`, `LoadingPhase`, `HostKind`, `AgentProvider`, etc.)
- `glossary/`, `knowledge/`, `recommendations/` — static data
- `docs/` — product documentation (this file)

**Stack:** TypeScript, React 18, esbuild, vitest (153 tests)

---

## 9. Data & privacy

| Data | Location | Leaves machine? |
|------|----------|-----------------|
| Transcripts | Agent-managed `.jsonl` (Cursor, Copilot workspace storage, or `~/.claude`) | No (read only) |
| Hook events | `lumen/events/` | No |
| Research cache | `lumen/research/`, or extension global storage off Cursor | No |
| LLM recap / recommendations | Editor LM API | Only if enabled; redacted |
| Web search query | Context.dev | Only if API key set; path-stripped, ≤200 chars |

**Never displayed:** `.env` contents, API keys, credential files.

**Context.dev API key:** stored in editor secret storage — never in settings JSON, workspace, or webview.

---

## 10. Success metrics

| Metric | Target | Measurement |
|--------|--------|-------------|
| Comprehension | User can describe last agent action without reading terminal | Qualitative / user interviews |
| Turn recap clarity | User understands turn outcome from recap alone | Qualitative |
| Template coverage | ≥80% steps explained without LLM at step level | `dogfood` coverage report |
| Concept coverage | ≥70% edits match ≥1 concept | Session builder stats |
| Resource engagement | User opens ≥1 learning resource per session | Future telemetry (not in v0.2) |
| Recommendation relevance | User finds ≥1 suggestion worth exploring | Qualitative |
| Loader perceived calm | User does not see partial timeline during active turn | UX observation |
| Latency after turn | Recap + suggestions within acceptable wait | Overlay duration observation |

---

## 11. Known limitations (v0.3)

1. **No official "active conversation" API** — uses latest-modified transcript heuristic + hook `conversation_id`
2. **Hooks are Cursor-only** — in VS Code there is no command output, diffs, exit codes, or agent model for the witty phrases; Copilot's transcript supplies durations and pass/fail, Claude's supplies tool results
3. **Knowledge graph is curated** — ~57 seed concepts; unknown patterns not auto-expanded
4. **Per-workspace, local only** — no sync across machines
5. **IDE-only** — cloud agents not supported
6. **Sidebar width constrained** — optimized for ~360px VS Code sidebar
7. **Overlay reappears each turn** — by design; cached finished chats open instantly
8. **Web search requires Context.dev key** — without it, suggestions come from catalog + LLM only
9. **Loader requires an up-to-date install** — local dev changes are not picked up until `npm run install:cursor` / `install:vscode` and a window reload
10. **Opening Lumen after the turn finishes** — by design, no loader; the host pre-builds recap and suggestions in the background while the sidebar is closed
11. **Claude Code persistence is unreliable in VS Code** — upstream issues report sessions saved as metadata-only stubs ([anthropics/claude-code#79118](https://github.com/anthropics/claude-code/issues/79118), [#22900](https://github.com/anthropics/claude-code/issues/22900)). Lumen detects these, keeps them out of `auto` selection, and shows a quiet source note instead of an empty timeline.
12. **Copilot and Claude transcript formats are undocumented** — each adapter is fixture-tested and version-sniffs where it can, but an upstream format change can degrade a timeline. `lumen.dataSource` and the directory overrides are the escape hatches.
13. **Copilot workspace matching depends on `workspace.json`** — folders opened without a workspace file, or exotic multi-root setups, may not resolve; `lumen.projectsDirOverride` is the manual fallback.

---

## 12. Future roadmap (not in v0.3)

| Phase | Feature |
|-------|---------|
| v0.3 polish | Figma mockups aligned to turn recap + overlay (Activity tab frame still shows old summary strip); README screenshots for both hosts |
| v0.4 | VS Code hook capture once `chatParticipantPrivate` / hooks execution stabilise; optional minimum splash on open; manual research as default for power users |
| v0.4+ | Cross-conversation browser, community-editable concepts, replay/scrub timeline, further agents (Cline, Continue) behind the same store seam |
| Later | Team dashboards, PDF export for stakeholders, learning progress (if reintroduced without v0.1 debt model) |

**Design artifact:** [Lumen UI (Figma)](https://www.figma.com/design/l8qUkbC8pDRhizd8bAAPlF) — needs update for turn recap and overlay UX.

---

## 13. Release criteria (v0.3 — met)

- [x] Activity bar webview with live timeline
- [x] Transcript parser + tool categorization + hooks plugin
- [x] Template engine (~60 patterns) + glossary (~102 terms)
- [x] Knowledge graph (~57 concepts) without debt scoring
- [x] Learn & improve tab with resources + recommendations
- [x] Improvement research (catalog + LLM + optional Context.dev)
- [x] Loading overlay with SVG + witty phrases + model-aware nouns
- [x] Overlay holds through active turn + enrich; 300ms dissolve
- [x] Turn recap at bottom (headline + paragraph); summary strip removed
- [x] Export resource sheet (Markdown)
- [x] Host detection + `TranscriptStore` abstraction; Cursor path unchanged
- [x] Copilot Chat adapter (event stream + `chatSessions` fallback) with fixture tests
- [x] Claude Code adapter with sidechain nesting and metadata-only stub detection
- [x] Host-aware copy; hooks banner and command gated on `lumen.hooksSupported`
- [x] `LICENSE`, `repository`, and Marketplace icon in the package
- [x] 153 unit tests passing
- [x] Dogfood validated on real sessions (`--source`, `--file` + `--format`)

---

## 14. Open questions

1. Should the recap stay visible while scrolling a long timeline, or collapse to a compact bar?
2. Is there demand for a "manager view" export (PDF/Markdown for non-IDE stakeholders)?
3. ~~Should Lumen publish to Open VSX / Cursor marketplace, or stay sideload-only?~~ **Answered in v0.3:** publish to both the VS Code Marketplace and Open VSX.
4. Should `lumen.research.trigger` default flip to `manual` once users complain about overlay duration on long research runs?
5. Should learning progress return in a lighter form (bookmarks/favorites) without the v0.1 debt model?
6. When a workspace has both Copilot and Claude Code transcripts, should the picker show conversations from both at once rather than making `lumen.dataSource` an either/or?

---

## Appendix A: v0.2 → v0.3 changelog (product)

| Added / changed | Detail |
|-----------------|--------|
| Multi-host support | Runs in VS Code and VS Code Insiders as well as Cursor |
| Copilot Chat as a source | Workspace storage discovery by folder URI; typed event stream parser with `chatSessions` fallback |
| Claude Code as a source | `~/.claude/projects` discovery; sidechain work nests as subagent steps; metadata-only stubs detected |
| `TranscriptStore` seam | Replaces Cursor-only path resolution; one store per agent, one parser per format |
| Canonical tool names | Copilot and Claude tool names and argument keys remap onto the existing template set |
| `lumen.dataSource` | Pin the agent, or let `auto` prefer the host's own |
| Host-aware copy | Loading phrases, empty states, and footer name the active agent |
| Hooks gating | Install banner and command hidden outside Cursor; quiet source-note banner replaces dead ends |
| `lumen.projectsDirOverride`, `lumen.claudeConfigDir` | Directory escape hatches; `cursorProjectsDir` kept as a deprecated alias |
| Packaging | `LICENSE`, `repository`, Marketplace icon, `install:vscode`, Marketplace + Open VSX publish scripts |

---

## Appendix B: v0.1 → v0.2 changelog (product)

| Removed | Added / changed |
|---------|-----------------|
| Knowledge Debt scoring & queue | Learn & improve tab |
| Learned / seen / new concept status | Neutral concept tags |
| Profile persistence (`profile.json`) | Per-turn research cache |
| Debt badge, blind spots, progress | Turn recap (bottom) |
| Top summary strip | Loading overlay over stage |
| Export learning plan, reset profile | Export resource sheet |
| LLM only for "complex" turns | LLM recap for every finished turn with steps |
| Full-panel replace loader | Cards build under overlay + fade reveal |

---

## Appendix C: Key files (v0.3)

| Area | Files |
|------|-------|
| Host detection | `extension/src/host/detectHost.ts` |
| Transcript discovery | `extension/src/host/transcriptStore.ts`, `copilotPaths.ts`, `claudePaths.ts`, `extension/src/paths.ts` |
| Transcript adapters | `extension/src/parser/adapters/` (`index.ts`, `copilotTranscript.ts`, `copilotChatSession.ts`, `claudeTranscript.ts`), `extension/src/parser/transcriptParser.ts` |
| Tool-name normalisation | `extension/src/parser/adapters/copilotTools.ts`, `claudeTools.ts` |
| Loading phase logic | `extension/src/loading/resolveLoadingPhase.ts` |
| Overlay fade + initial visibility | `extension/src/loading/overlayVisibility.ts`, `LoadingState.tsx` |
| Sidebar visibility → webview | `extension/src/extension.ts` (`view.onDidChangeVisibility`, `viewVisible` / `viewHidden` messages) |
| Loading phrases | `extension/src/loading/loadingPhrases.ts`, `agentModel.ts` |
| Turn recap UI | `extension/src/webview/components/TurnRecap.tsx` |
| Recap copy | `extension/src/session/sessionBuilder.ts` (`composeTurn`, `composeTurnRecap`) |
| LLM recap | `extension/src/explainer/llmSummarizer.ts` |
| Research | `extension/src/research/researchService.ts`, `recommendations/catalog.json` |
| Learn UI | `extension/src/webview/components/LearnImprovePanel.tsx` |
| Schema | `shared/activity-schema.ts` (`liveHeadline`, `liveSummary`, `LoadingPhase`, `HostKind`, `AgentProvider`, `DataSourcePreference`) |
| Packaging | `extension/package.json`, `extension/.vscodeignore`, `extension/scripts/buildIcon.mjs`, `LICENSE` |
