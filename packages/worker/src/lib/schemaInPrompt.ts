import type { LanguageModelMiddleware } from 'ai';

type CallParams = Parameters<NonNullable<LanguageModelMiddleware['transformParams']>>[0]['params'];

/**
 * Puts the response schema of a structured-output call into the system prompt.
 *
 * The OpenAI-compatible adapter cannot assume an endpoint honours
 * `response_format: json_schema`, so for a JSON response it sends plain
 * `json_object` mode and drops the schema. Mastra adds the schema to the prompt
 * only when a call opts into `jsonPromptInjection`, which none of ours do — so
 * without this a model behind OpenRouter, OpenCode Go, Ollama or vLLM is asked
 * for "some JSON" and its answer fails the caller's Zod schema. Wrapping the
 * model here covers every structured-output call site at once, and leaves the
 * built-in providers, which enforce the schema natively, untouched.
 */
export const schemaInPromptMiddleware: LanguageModelMiddleware = {
  specificationVersion: 'v4',
  transformParams: async ({ params }) => withSchemaInstruction(params),
};

export function withSchemaInstruction(params: CallParams): CallParams {
  const format = params.responseFormat;
  if (format?.type !== 'json' || format.schema == null) {
    return params;
  }
  const instruction = [
    'Respond with a single JSON object that conforms to this JSON schema.',
    'Return only the JSON object: no prose before or after it and no code fences.',
    JSON.stringify(format.schema),
  ].join('\n');
  const [first, ...rest] = params.prompt;
  const prompt: CallParams['prompt'] =
    first?.role === 'system'
      ? [{ ...first, content: `${first.content}\n\n${instruction}` }, ...rest]
      : [{ content: instruction, role: 'system' }, ...params.prompt];
  return { ...params, prompt };
}
