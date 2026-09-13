import type { HookEvent } from '../../../shared/activity-schema';

/**
 * The model driving the user's agent chat, used only to flavour the loading phrases.
 *
 * Agent transcripts do not record the model, but Cursor passes `model` / `model_id` to every
 * hook, and the Decipher hook persists it on `sessionStart` and `beforeSubmitPrompt`. Without
 * hooks installed this returns undefined and the loader falls back to the generic noun pool.
 */
export function agentModelFromEvents(events: HookEvent[]): string | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const raw = events[i].model ?? events[i].modelId;
    const model = raw?.trim();
    if (model) return model;
  }
  return undefined;
}
