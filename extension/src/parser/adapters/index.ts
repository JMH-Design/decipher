import type { AgentProvider } from '../../host/detectHost';
import { parseTranscript, type ParsedTranscript, type ParseOptions } from '../transcriptParser';
import { parseClaudeTranscript } from './claudeTranscript';
import { parseCopilotChatSession } from './copilotChatSession';
import { parseCopilotTranscript } from './copilotTranscript';

/**
 * Every agent writes its own transcript format; every adapter produces the same
 * `ParsedTranscript`. Nothing downstream of this file knows which editor it is running in.
 */
export type TranscriptParser = (conversationId: string, jsonl: string, opts?: ParseOptions) => ParsedTranscript;

/** Copilot has two on-disk formats; the store decides which one a given file is. */
export type TranscriptFormat = AgentProvider | 'copilot-chat-session';

const PARSERS: Record<TranscriptFormat, TranscriptParser> = {
  cursor: parseTranscript,
  copilot: parseCopilotTranscript,
  'copilot-chat-session': parseCopilotChatSession,
  'claude-code': parseClaudeTranscript,
};

export function parserFor(format: TranscriptFormat): TranscriptParser {
  return PARSERS[format] ?? parseTranscript;
}

export { parseClaudeTranscript, parseCopilotChatSession, parseCopilotTranscript };
