#!/usr/bin/env node
/**
 * Decipher hook: receives a Cursor hook payload on stdin and appends a compact,
 * redacted event to `~/.cursor/projects/<slug>/decipher/events/<conversation_id>.jsonl`.
 *
 * Design rules:
 * - Never block the agent: always exit 0 and print a valid JSON object.
 * - Never persist secrets: outputs are redacted and truncated before writing.
 * - Stay dependency-free so it runs from any plugin location.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const MAX_OUTPUT_CHARS = 20_000;
const MAX_EDIT_CHARS = 8_000;

function workspaceSlug(workspacePath) {
  return String(workspacePath).replace(/^[\\/]+/, '').replace(/[^A-Za-z0-9]/g, '-');
}

function redact(text) {
  if (typeof text !== 'string') return text;
  return text
    .replace(/(--?(?:token|password|passwd|secret|api[-_]?key|authorization)[=\s]+)(\S+)/gi, '$1[redacted]')
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_KEY|PRIVATE_KEY)[A-Z0-9_]*\s*[=:]\s*)(\S+)/g, '$1[redacted]')
    .replace(/\b(sk|ghp|gho|ghu|xoxb|xoxp|AKIA)[-_]?[A-Za-z0-9_-]{8,}/g, '[redacted]')
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, 'Bearer [redacted]')
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, '[redacted private key]');
}

function truncate(text, max) {
  if (typeof text !== 'string') return text;
  return text.length > max ? `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]` : text;
}

function isSensitivePath(p) {
  return /(^|\/)\.env(\.|$)|\.pem$|\.key$|id_rsa|id_ed25519|\/secrets?\//i.test(String(p ?? ''));
}

function respond(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (data += c));
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    setTimeout(() => resolve(data), 2000).unref();
  });
}

function buildEvent(payload) {
  const hook = payload.hook_event_name ?? 'unknown';
  const ev = {
    ts: new Date().toISOString(),
    hook,
    conversationId: payload.conversation_id ?? 'unknown',
    generationId: payload.generation_id,
  };

  switch (hook) {
    case 'postToolUse':
      ev.toolName = payload.tool_name;
      ev.toolUseId = payload.tool_use_id;
      ev.toolInput = sanitizeInput(payload.tool_input);
      ev.toolOutput = truncate(redact(payload.tool_output), MAX_OUTPUT_CHARS);
      ev.durationMs = payload.duration;
      break;
    case 'postToolUseFailure':
      ev.toolName = payload.tool_name;
      ev.toolUseId = payload.tool_use_id;
      ev.toolInput = sanitizeInput(payload.tool_input);
      ev.errorMessage = truncate(redact(payload.error_message), 2000);
      ev.status = payload.failure_type;
      ev.durationMs = payload.duration;
      break;
    case 'afterShellExecution':
      ev.command = redact(payload.command);
      ev.output = truncate(redact(payload.output), MAX_OUTPUT_CHARS);
      ev.durationMs = payload.duration;
      break;
    case 'afterMCPExecution':
      ev.toolName = payload.tool_name;
      ev.toolInput = { server: payload.mcp_server_name, params: truncate(redact(payload.tool_input), 4000) };
      ev.toolOutput = truncate(redact(payload.result_json), MAX_OUTPUT_CHARS);
      ev.durationMs = payload.duration;
      break;
    case 'afterFileEdit':
      ev.filePath = payload.file_path;
      ev.edits = isSensitivePath(payload.file_path)
        ? [{ old_string: '[hidden: sensitive file]', new_string: '[hidden: sensitive file]' }]
        : (payload.edits ?? []).map((e) => ({
            old_string: truncate(redact(e.old_string ?? ''), MAX_EDIT_CHARS),
            new_string: truncate(redact(e.new_string ?? ''), MAX_EDIT_CHARS),
          }));
      break;
    case 'subagentStop':
      ev.subagentType = payload.subagent_type;
      ev.status = payload.status;
      ev.summary = truncate(redact(payload.summary), 4000);
      ev.modifiedFiles = payload.modified_files;
      ev.durationMs = payload.duration_ms;
      break;
    case 'beforeSubmitPrompt':
      ev.prompt = truncate(redact(payload.prompt), 4000);
      recordModel(ev, payload);
      break;
    case 'afterAgentResponse':
      ev.text = truncate(redact(payload.text), 6000);
      break;
    case 'stop':
      ev.status = payload.status;
      break;
    case 'sessionStart':
      ev.status = payload.composer_mode;
      recordModel(ev, payload);
      break;
    default:
      break;
  }
  return ev;
}

/**
 * Cursor passes the active model on every agent hook. Decipher only needs it to caption its
 * loading state, so we record it on the two per-turn hooks rather than on every tool call.
 */
function recordModel(ev, payload) {
  const model = payload.model ?? payload.model_id;
  if (typeof model === 'string' && model.trim()) ev.model = model.trim().slice(0, 80);
  if (typeof payload.model_id === 'string' && payload.model_id.trim()) ev.modelId = payload.model_id.trim().slice(0, 80);
}

function sanitizeInput(input) {
  if (!input || typeof input !== 'object') return input;
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === 'string') out[k] = truncate(redact(v), MAX_EDIT_CHARS);
    else out[k] = v;
  }
  return out;
}

function hookResponse(hook) {
  // Observational hooks must still return valid JSON; permission hooks must allow.
  if (hook === 'beforeSubmitPrompt') return { continue: true };
  return {};
}

async function main() {
  let payload = {};
  try {
    const raw = await readStdin();
    payload = raw ? JSON.parse(raw) : {};
  } catch {
    respond({});
    return;
  }

  try {
    const roots = Array.isArray(payload.workspace_roots) ? payload.workspace_roots : [];
    const root = roots[0] ?? process.env.CURSOR_PROJECT_DIR ?? process.cwd();
    const eventsDir = join(homedir(), '.cursor', 'projects', workspaceSlug(root), 'decipher', 'events');
    mkdirSync(eventsDir, { recursive: true });
    const ev = buildEvent(payload);
    const file = join(eventsDir, `${String(ev.conversationId).replace(/[^A-Za-z0-9_-]/g, '_')}.jsonl`);
    appendFileSync(file, `${JSON.stringify(ev)}\n`, 'utf8');
  } catch {
    // swallow: never break the agent loop because of an explainer
  }
  respond(hookResponse(payload.hook_event_name));
}

main();
