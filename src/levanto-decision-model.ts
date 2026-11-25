import {
  InvalidArgumentError,
  InvalidResponseDataError,
  UnsupportedFunctionalityError,
  type Experimental_DecisionModelV4 as DecisionModelV4,
  type Experimental_DecisionModelV4Answer as DecisionModelV4Answer,
  type JSONObject,
  type JSONValue,
  type SharedV4Warning,
} from '@ai-sdk/provider';
import {
  combineHeaders,
  createJsonResponseHandler,
  lazySchema,
  parseProviderOptions,
  postJsonToApi,
  resolve,
  withUserAgentSuffix,
  zodSchema,
  type FetchFunction,
  type InferSchema,
} from '@ai-sdk/provider-utils';
import { USER_AGENT } from './version';
import * as z from 'zod/v4';
import { levantoFailedResponseHandler, systemOneResponseSchema } from './levanto-api';

export type LevantoDecisionModelId = 'sage-latest' | 'levanto-sage-2' | (string & {});

export const levantoDecisionOptions = lazySchema(() =>
  zodSchema(
    z.object({
      /** `off` (default), `auto` or `on`. Overrides the call's `reasoning`. */
      reasoning: z.enum(['off', 'auto', 'on']).optional(),
      /** Search the web before answering: one config, or `{ questionId: config }`. */
      grounding: z.record(z.string(), z.unknown()).optional(),
      /** Answer several boolean questions as one tag set: `{ name: { questions, instructions } }`. */
      tags: z.record(z.string(), z.unknown()).optional(),
      /** Sort a list from the state: `{ name: { items, instructions } }`. */
      sort: z.record(z.string(), z.unknown()).optional(),
    }),
  ),
);

export type LevantoDecisionOptions = InferSchema<typeof levantoDecisionOptions>;

export type LevantoModelConfig = {
  provider: string;
  baseURL: string;
  headers: () => Promise<Record<string, string | undefined>> | Record<string, string | undefined>;
  fetch?: FetchFunction;
};

const MAX_QUESTIONS = 64;

type DecideOptions = Parameters<DecisionModelV4['doDecide']>[0];
type DecideResult = Awaited<ReturnType<DecisionModelV4['doDecide']>>;

export class LevantoDecisionModel implements DecisionModelV4 {
  readonly specificationVersion = 'v4';
  readonly supportedQuestionTypes = ['boolean', 'choice', 'score'] as const;

  constructor(
    readonly modelId: LevantoDecisionModelId,
    private readonly config: LevantoModelConfig,
  ) {}

  get provider() {
    return this.config.provider;
  }

  async doDecide({
    state,
    questions,
    maxOutputTokens,
    reasoning,
    headers,
    abortSignal,
    providerOptions,
  }: DecideOptions): Promise<DecideResult> {
    const ids = Object.keys(questions);
    if (ids.length > MAX_QUESTIONS) {
      throw new InvalidArgumentError({
        argument: 'questions',
        message: `Levanto takes up to ${MAX_QUESTIONS} questions per call.`,
      });
    }

    const warnings: SharedV4Warning[] = [];
    if (maxOutputTokens != null) warnings.push({ type: 'unsupported', feature: 'maxOutputTokens' });

    const levantoOptions =
      (await parseProviderOptions({ provider: 'levanto', providerOptions, schema: levantoDecisionOptions })) ?? {};
    const options: Record<string, JSONValue> = {};
    const reasoningMode = levantoOptions.reasoning ?? mapReasoning(reasoning);
    if (reasoningMode) options.reasoning = reasoningMode;
    for (const key of ['grounding', 'tags', 'sort'] as const) {
      if (levantoOptions[key] !== undefined) options[key] = levantoOptions[key] as JSONValue;
    }

    const body: Record<string, unknown> = {
      model: this.modelId,
      state: toSystemOneState(state),
      questions: Object.fromEntries(ids.map(id => [id, toSystemOneQuestion(id, questions[id])])),
    };
    if (Object.keys(options).length > 0) body.provider = { options: { levanto: options } };

    const { value: response, rawValue, responseHeaders } = await postJsonToApi({
      url: `${this.config.baseURL}/v1/systemone`,
      headers: withUserAgentSuffix(combineHeaders(await resolve(this.config.headers), headers), USER_AGENT),
      body,
      failedResponseHandler: levantoFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(zodSchema(systemOneResponseSchema)),
      abortSignal,
      fetch: this.config.fetch,
    });

    const answers: Record<string, DecisionModelV4Answer> = {};
    const confidence: JSONObject = {};
    for (const id of ids) {
      const raw = response.answers[id];
      if (raw === undefined) {
        throw new InvalidResponseDataError({ data: rawValue, message: `Levanto returned no answer for question "${id}".` });
      }
      answers[id] = toAnswer(id, questions[id].type, raw, rawValue);
      if (typeof raw.confidence === 'number') confidence[id] = raw.confidence;
    }

    const extra: JSONObject = {};
    for (const [id, raw] of Object.entries(response.answers)) {
      if (!(id in questions)) extra[id] = raw as JSONValue;
    }

    const levanto: JSONObject = { confidence };
    if (Object.keys(extra).length > 0) levanto.answers = extra;
    if (response.annotations && response.annotations.length > 0) levanto.annotations = response.annotations as JSONValue;

    return {
      answers,
      usage: {
        inputTokens: response.usage?.input_tokens ?? undefined,
        outputTokens: response.usage?.output_tokens ?? undefined,
      },
      warnings,
      providerMetadata: { levanto },
      response: {
        modelId: response.model ?? this.modelId,
        headers: responseHeaders,
        body: rawValue,
      },
    };
  }
}

/** The AI SDK's reasoning effort, as Levanto's reasoning mode. */
export function mapReasoning(reasoning: DecideOptions['reasoning']): 'off' | 'on' | undefined {
  if (reasoning == null || reasoning === 'provider-default') return undefined;
  return reasoning === 'none' ? 'off' : 'on';
}

export function toSystemOneState(state: DecideOptions['state']): JSONValue {
  if (state.some(part => part.type === 'file')) {
    throw new UnsupportedFunctionalityError({
      functionality: 'Levanto decisions with files or images through the AI SDK (use POST /decide for images)',
    });
  }
  if (state.length === 1 && state[0].type === 'json') {
    const value = state[0].value;
    if (typeof value === 'string' || (value !== null && typeof value === 'object')) return value;
    return JSON.stringify(value);
  }
  return state
    .map(part => (part.type === 'text' ? part.text : part.type === 'json' ? JSON.stringify(part.value) : ''))
    .join('\n');
}

export function toSystemOneQuestion(id: string, question: DecideOptions['questions'][string]): JSONObject {
  const out: JSONObject = {};
  if (question.instructions != null) out.instructions = question.instructions as JSONValue;
  switch (question.type) {
    case 'boolean': {
      out.type = 'noul';
      const criteria: JSONObject = {};
      if (question.criteria?.true != null) criteria.true = question.criteria.true as JSONValue;
      if (question.criteria?.false != null) criteria.false = question.criteria.false as JSONValue;
      if (Object.keys(criteria).length > 0) out.criteria = criteria;
      return out;
    }
    case 'choice': {
      const n = Object.keys(question.criteria).length;
      if (n < 2 || n > 256) {
        throw new InvalidArgumentError({
          argument: `questions.${id}.criteria`,
          message: 'Levanto choice questions take 2 to 256 options.',
        });
      }
      out.type = 'choice';
      out.criteria = question.criteria as JSONObject;
      return out;
    }
    case 'score': {
      const n = question.criteria.length;
      if (n < 2 || n > 26 || question.criteria.some(level => level == null)) {
        throw new InvalidArgumentError({
          argument: `questions.${id}.criteria`,
          message: 'Levanto score questions take 2 to 26 levels, none of them null.',
        });
      }
      out.type = 'score';
      out.criteria = question.criteria as JSONValue[];
      return out;
    }
    default:
      throw new UnsupportedFunctionalityError({ functionality: `Levanto decision question type: ${question.type}` });
  }
}

function toAnswer(
  id: string,
  type: 'boolean' | 'choice' | 'score' | 'box',
  raw: Record<string, unknown>,
  body: unknown,
): DecisionModelV4Answer {
  const bad = () =>
    new InvalidResponseDataError({ data: body, message: `Levanto returned an unexpected answer for question "${id}".` });
  switch (type) {
    case 'boolean':
      if (raw.type !== 'noul' || typeof raw.noul !== 'number') throw bad();
      return { type: 'boolean', probability: raw.noul };
    case 'choice':
      if (raw.type !== 'choice' || typeof raw.choice !== 'string') throw bad();
      return { type: 'choice', choice: raw.choice, probabilities: numberRecord(raw.probabilities) };
    case 'score':
      if (raw.type !== 'score' || typeof raw.score !== 'number') throw bad();
      return { type: 'score', score: raw.score, probabilities: numberRecord(raw.probabilities) };
    default:
      throw bad();
  }
}

function numberRecord(value: unknown): Record<string, number> | undefined {
  if (value === null || typeof value !== 'object') return undefined;
  const entries = Object.entries(value as Record<string, unknown>).filter(
    (e): e is [string, number] => typeof e[1] === 'number',
  );
  return Object.fromEntries(entries);
}
