import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import {
  NoSuchModelError,
  type Experimental_DecisionModelV4 as DecisionModelV4,
  type Experimental_ExtractionModelV4 as ExtractionModelV4,
  type LanguageModelV4,
  type ProviderV4,
} from '@ai-sdk/provider';
import {
  loadApiKey,
  loadOptionalSetting,
  resolve,
  withUserAgentSuffix,
  withoutTrailingSlash,
  type FetchFunction,
  type Resolvable,
} from '@ai-sdk/provider-utils';
import { LevantoDecisionModel, type LevantoDecisionModelId } from './levanto-decision-model';
import { LevantoExtractionModel, type LevantoExtractionModelId } from './levanto-extraction-model';
import { USER_AGENT } from './version';

/** `auto` lets the router pick per request; any id from `GET /v1/models` pins one model. */
export type LevantoChatModelId = 'auto' | (string & {});

export interface LevantoProviderSettings {
  /** API key. Defaults to the `LEVANTO_API_KEY` environment variable. */
  apiKey?: Resolvable<string>;
  /** Defaults to the `LEVANTO_BASE_URL` environment variable, then `https://api.levanto.ai`. */
  baseURL?: string;
  /** Extra headers on every request. */
  headers?: Record<string, string>;
  /** Custom fetch, for proxies or tests. */
  fetch?: FetchFunction;
}

export interface LevantoProvider extends ProviderV4 {
  /** A Levanto LLM, for `generateText`, `streamText` and the rest. */
  (modelId: LevantoChatModelId): LanguageModelV4;
  languageModel(modelId: LevantoChatModelId): LanguageModelV4;
  chatModel(modelId: LevantoChatModelId): LanguageModelV4;
  /** Sage, for `experimental_decide`. */
  decisionModel(modelId: LevantoDecisionModelId): DecisionModelV4;
  /** Sage, for `experimental_extract`. */
  extractionModel(modelId: LevantoExtractionModelId): ExtractionModelV4;
}

export function createLevanto(options: LevantoProviderSettings = {}): LevantoProvider {
  const baseURL =
    withoutTrailingSlash(loadOptionalSetting({ settingValue: options.baseURL, environmentVariableName: 'LEVANTO_BASE_URL' })) ??
    'https://api.levanto.ai';

  const apiKey = async () =>
    loadApiKey({
      apiKey: await resolve(options.apiKey),
      environmentVariableName: 'LEVANTO_API_KEY',
      description: 'Levanto',
    });

  const headers = async () => ({ Authorization: `Bearer ${await apiKey()}`, ...options.headers });

  const llms = createOpenAICompatible({
    name: 'levanto',
    baseURL: `${baseURL}/v1`,
    // The key is read per request, so a missing key fails the call, not the import.
    apiKey: undefined,
    headers: undefined,
    fetch: async (input, init) => {
      const merged = new Headers(init?.headers);
      for (const [k, v] of Object.entries(await headers())) if (v !== undefined) merged.set(k, v);
      const current: Record<string, string> = {};
      merged.forEach((v, k) => (current[k] = v));
      merged.set('user-agent', withUserAgentSuffix(current, USER_AGENT)['user-agent']!);
      return (options.fetch ?? globalThis.fetch)(input, { ...init, headers: merged });
    },
    includeUsage: true,
  });

  const config = (kind: string) => ({ provider: `levanto.${kind}`, baseURL, headers, fetch: options.fetch });

  const languageModel = (modelId: LevantoChatModelId) => llms.chatModel(modelId);
  const provider = function (modelId: LevantoChatModelId) {
    if (new.target) throw new Error('The Levanto provider is a function; call it without `new`.');
    return languageModel(modelId);
  };

  provider.specificationVersion = 'v4' as const;
  provider.languageModel = languageModel;
  provider.chatModel = languageModel;
  provider.decisionModel = (modelId: LevantoDecisionModelId) => new LevantoDecisionModel(modelId, config('decision'));
  provider.extractionModel = (modelId: LevantoExtractionModelId) => new LevantoExtractionModel(modelId, config('extraction'));
  provider.embeddingModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'embeddingModel' });
  };
  provider.imageModel = (modelId: string) => {
    throw new NoSuchModelError({ modelId, modelType: 'imageModel' });
  };

  return provider as LevantoProvider;
}

/** The default provider: key from `LEVANTO_API_KEY`. */
export const levanto = createLevanto();
