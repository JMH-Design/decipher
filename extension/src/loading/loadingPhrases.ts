/**
 * Loading phrases for the full-panel loader.
 *
 * Every phrase follows the same shape: an understanding verb in the present participle,
 * then a noun for the thing being understood — "Deciphering the black box".
 * When the agent's model is known we mix in jokes about that specific model.
 *
 * Pure data + pure functions: this module is bundled into the webview, so it must not
 * import anything from Node or `vscode`.
 */

/** Present participles, all about the act of understanding. */
export const VERBS = [
  'Analyzing',
  'Grasping',
  'Comprehending',
  'Deciphering',
  'Unpacking',
  'Demystifying',
  'Parsing',
  'Translating',
  'Illuminating',
  'Distilling',
  'Decoding',
  'Untangling',
  'Interpreting',
  'Digesting',
  'Fathoming',
  'Making sense of',
] as const;

export interface LoadingNoun {
  text: string;
  /** Prefix with "the". Off for possessives and proper nouns ("Claude's inner monologue"). */
  article: boolean;
}

const generic = (text: string): LoadingNoun => ({ text, article: true });
const owned = (text: string): LoadingNoun => ({ text, article: false });

/** Nouns that work for any model. */
export const GENERIC_NOUNS: LoadingNoun[] = [
  generic('black box'),
  generic('magic'),
  generic('voodoo'),
  generic('mysteries of the cosmos'),
  generic('mysteries of the machine'),
  generic('neural fog'),
  generic('token soup'),
  generic('probability cloud'),
  generic('latent space'),
  generic('hieroglyphs'),
  generic('robot handwriting'),
  generic('incantations'),
  generic('digital tea leaves'),
  generic('spaghetti'),
  generic('oracle'),
  generic('ghost in the machine'),
];

/**
 * Model-specific jokes, keyed by a pattern matched against the reported model name.
 * First match wins, so put the more specific families first.
 */
const MODEL_NOUNS: Array<{ match: RegExp; nouns: LoadingNoun[] }> = [
  {
    match: /composer|cursor-(?!grok)/,
    nouns: [owned("Composer's rehearsal room"), owned("Cursor's house band"), generic('conductor at work')],
  },
  {
    match: /claude|sonnet|opus|haiku|anthropic|fable/,
    nouns: [
      owned("Claude's inner monologue"),
      owned("Anthropic's very polite oracle"),
      generic('thoughtful pause'),
      generic('constitutionally cautious genius'),
    ],
  },
  {
    match: /gpt|openai|o[1-9](?:-|$)|sol/,
    nouns: [owned("GPT's autocomplete instinct"), owned("OpenAI's prediction engine"), generic('confident guess')],
  },
  {
    match: /gemini|google|bard/,
    nouns: [owned("Gemini's twin perspectives"), owned("Google's second opinion")],
  },
  {
    match: /grok|xai/,
    nouns: [owned("Grok's unfiltered take"), generic('hot take')],
  },
  {
    match: /llama|mistral|qwen|deepseek|kimi|glm/,
    nouns: [generic('open-weights wizardry'), generic('community brain trust')],
  },
];

/** Nouns available for a given model: its own jokes first, then the generic pool. */
export function nounsForModel(model: string | undefined): LoadingNoun[] {
  const m = (model ?? '').toLowerCase();
  const specific = m ? MODEL_NOUNS.find((e) => e.match.test(m))?.nouns : undefined;
  return specific ? [...specific, ...GENERIC_NOUNS] : GENERIC_NOUNS;
}

export function renderPhrase(verb: string, noun: LoadingNoun): string {
  return `${verb} ${noun.article ? 'the ' : ''}${noun.text}…`;
}

/**
 * One random phrase. `random` is injectable so tests stay deterministic.
 */
export function loadingPhrase(model?: string, random: () => number = Math.random): string {
  const nouns = nounsForModel(model);
  const verb = VERBS[Math.floor(random() * VERBS.length) % VERBS.length];
  const noun = nouns[Math.floor(random() * nouns.length) % nouns.length];
  return renderPhrase(verb, noun);
}
