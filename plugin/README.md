# Decipher Hooks (Cursor plugin)

Companion plugin for the Decipher sidebar extension. Cursor's agent transcripts record *which* tools ran but not what they returned; these hooks capture the missing half (shell output, edit diffs, failures, subagent summaries) so the sidebar can say "the search found 0 matches" instead of just "searched".

## What it writes

One JSON line per event, redacted and truncated, to:

```
~/.cursor/projects/<workspace-slug>/decipher/events/<conversation_id>.jsonl
```

Nothing leaves your machine. Values that look like tokens, passwords, or private keys are replaced with `[redacted]`; edits to `.env`, `*.pem`, `*.key`, and similar files are hidden entirely.

## Install (local)

```bash
mkdir -p ~/.cursor/plugins/local
cp -R plugin ~/.cursor/plugins/local/decipher-hooks
chmod +x ~/.cursor/plugins/local/decipher-hooks/hooks/capture-event.mjs
```

Then run **Developer: Reload Window** in Cursor. The Decipher extension also offers a one-click **Install Cursor hooks** command that does the same thing.

## Events captured

| Hook | Why |
| --- | --- |
| `postToolUse` / `postToolUseFailure` | Tool inputs, outputs, durations, and error messages |
| `afterShellExecution` | Full terminal output of commands the agent ran |
| `afterMCPExecution` | Which outside tool (Figma, Slack, …) was used and what came back |
| `afterFileEdit` | The exact before/after text of edits (drives concept detection) |
| `subagentStop` | Summary and modified files from delegated sub-tasks |
| `beforeSubmitPrompt` | Your request, used to judge which concepts were central |
| `afterAgentResponse`, `stop`, `sessionStart` | Turn boundaries |
