import {
  InvalidArgumentError,
  InvalidResponseDataError,
  UnsupportedFunctionalityError,
  type Experimental_ExtractionModelV4 as ExtractionModelV4,
  type Experimental_ExtractionModelV4Answer as ExtractionModelV4Answer,
  type Experimental_ExtractionModelV4Field as ExtractionModelV4Field,
  type Experimental_ExtractionModelV4Source as ExtractionModelV4Source,
  type JSONObject,
  type SharedV4Warning,
} from '@ai-sdk/provider';
import {
  combineHeaders,
  createJsonResponseHandler,
  postJsonToApi,
  resolve,
  withUserAgentSuffix,
  zodSchema,
} from '@ai-sdk/provider-utils';
import { USER_AGENT } from './version';
import {
  extractResponseSchema,
  levantoFailedResponseHandler,
  type ExtractCandidate,
  type ExtractResult,
} from './levanto-api';
import type { LevantoModelConfig } from './levanto-decision-model';

export type LevantoExtractionModelId = 'sage-latest' | 'levanto-sage-2' | (string & {});

type ExtractOptions = Parameters<ExtractionModelV4['doExtract']>[0];
type ExtractResultV4 = Awaited<ReturnType<ExtractionModelV4['doExtract']>>;
type DurationUnit = NonNullable<Extract<ExtractionModelV4Field, { type: 'duration' }>['unit']>;

/** Separator between state parts in the text Sage reads. */
export const PART_SEPARATOR = '\n\n';
const MAX_FIELDS = 64;

const CURRENCY_SYMBOLS: Record<string, string> = { $: 'USD', '€': 'EUR', '£': 'GBP', '¥': 'JPY', '₹': 'INR', '₩': 'KRW' };

const SECONDS: Record<DurationUnit, number> = {
  seconds: 1,
  minutes: 60,
  hours: 3600,
  days: 86400,
  weeks: 7 * 86400,
  months: 30 * 86400,
  years: 365 * 86400,
};

export class LevantoExtractionModel implements ExtractionModelV4 {
  readonly specificationVersion = 'v4';
  readonly supportedFieldTypes = ['text', 'number', 'date', 'time', 'datetime', 'duration', 'list'] as const;

  constructor(
    readonly modelId: LevantoExtractionModelId,
    private readonly config: LevantoModelConfig,
  ) {}

  get provider() {
    return this.config.provider;
  }

  async doExtract({
    state,
    fields,
    referenceDate,
    maxOutputTokens,
    reasoning,
    headers,
    abortSignal,
    providerOptions,
  }: ExtractOptions): Promise<ExtractResultV4> {
    const ids = Object.keys(fields);
    if (ids.length > MAX_FIELDS) {
      throw new InvalidArgumentError({ argument: 'fields', message: `Levanto extracts up to ${MAX_FIELDS} fields per call.` });
    }

    const warnings: SharedV4Warning[] = [];
    if (referenceDate != null) {
      warnings.push({ type: 'unsupported', feature: 'referenceDate', details: 'Levanto returns only what the text states.' });
    }
    if (maxOutputTokens != null) warnings.push({ type: 'unsupported', feature: 'maxOutputTokens' });
    if (reasoning != null && reasoning !== 'provider-default') warnings.push({ type: 'unsupported', feature: 'reasoning' });
    for (const key of Object.keys(providerOptions?.levanto ?? {})) {
      warnings.push({ type: 'unsupported', feature: `providerOptions.levanto.${key}` });
    }

    const { content, parts } = joinState(state);
    const extract: JSONObject = {};
    for (const id of ids) {
      const { spec, warning } = toExtractSpec(fields[id]);
      extract[id] = spec;
      if (warning) warnings.push({ type: 'unsupported', feature: `fields.${id}.${warning}` });
    }

    const { value: response, rawValue, responseHeaders } = await postJsonToApi({
      url: `${this.config.baseURL}/v1/extract`,
      headers: withUserAgentSuffix(combineHeaders(await resolve(this.config.headers), headers), USER_AGENT),
      body: { content, extract },
      failedResponseHandler: levantoFailedResponseHandler,
      successfulResponseHandler: createJsonResponseHandler(zodSchema(extractResponseSchema)),
      abortSignal,
      fetch: this.config.fetch,
    });

    const answers: Record<string, ExtractionModelV4Answer> = {};
    const currency: JSONObject = {};
    for (const id of ids) {
      const result = response.results[id];
      if (result === undefined) {
        throw new InvalidResponseDataError({ data: rawValue, message: `Levanto returned no result for field "${id}".` });
      }
      const { answer, currencyCode } = toAnswer(fields[id], result, parts);
      answers[id] = answer;
      if (currencyCode !== undefined) currency[id] = currencyCode;
    }

    const levanto: JSONObject = {};
    if (Object.keys(currency).length > 0) levanto.currency = currency;

    return {
      answers,
      usage: {
        inputTokens: response.meta?.usage?.input_tokens ?? undefined,
        outputTokens: response.meta?.usage?.output_tokens ?? undefined,
      },
      warnings,
      providerMetadata: Object.keys(levanto).length > 0 ? { levanto } : undefined,
      response: {
        modelId: response.meta?.model ?? this.modelId,
        headers: responseHeaders,
        body: rawValue,
      },
    };
  }
}

// --- request -------------------------------------------------------------

type PartSpan = { index: number; text: string; start: number; length: number; isText: boolean };

/** Joins the state into the one text Sage reads, remembering where each part starts (in code points). */
export function joinState(state: ExtractOptions['state']): { content: string; parts: PartSpan[] } {
  const parts: PartSpan[] = [];
  let content = '';
  let offset = 0;
  state.forEach((part, index) => {
    if (part.type === 'file') {
      throw new UnsupportedFunctionalityError({ functionality: 'Levanto extraction from files or images through the AI SDK' });
    }
    const text = part.type === 'text' ? part.text : typeof part.value === 'string' ? part.value : JSON.stringify(part.value);
    if (parts.length > 0) {
      content += PART_SEPARATOR;
      offset += codePointLength(PART_SEPARATOR);
    }
    const length = codePointLength(text);
    parts.push({ index, text, start: offset, length, isText: part.type === 'text' });
    content += text;
    offset += length;
  });
  return { content, parts };
}

function definition(field: ExtractionModelV4Field): string {
  const { instructions } = field;
  if (instructions == null) return '';
  return typeof instructions === 'string' ? instructions : JSON.stringify(instructions);
}

export function currencyOf(unit: string | undefined): string | undefined {
  if (unit == null) return undefined;
  const u = unit.trim();
  if (CURRENCY_SYMBOLS[u]) return CURRENCY_SYMBOLS[u];
  return /^[A-Z]{3}$/.test(u) ? u : undefined;
}

export function toExtractSpec(field: ExtractionModelV4Field): { spec: JSONObject | JSONObject[]; warning?: string } {
  const def = definition(field);
  switch (field.type) {
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
      return { spec: { type: field.type, definition: def } };
    case 'duration':
      return { spec: { type: 'duration', definition: def } };
    case 'number': {
      if (currencyOf(field.unit)) return { spec: { type: 'money', definition: def } };
      return {
        spec: { type: field.integer ? 'integer' : 'decimal', definition: def },
        warning: field.unit != null ? 'unit' : undefined,
      };
    }
    case 'list': {
      const type = field.items === 'number' ? (field.integer ? 'integer' : 'decimal') : field.items;
      return { spec: [{ type, definition: def }] };
    }
    default:
      throw new UnsupportedFunctionalityError({
        functionality: `Levanto extraction field type: ${(field as { type: string }).type}`,
      });
  }
}

// --- response ------------------------------------------------------------

type Converted = { ok: true; value: string | number; currency?: string | null } | { ok: false; guess?: string | number; currency?: string | null };

/** Sage's value for a field, in the AI SDK's type for it. */
export function convertValue(field: ExtractionModelV4Field, raw: unknown): Converted {
  if (raw == null) return { ok: false };
  switch (field.type) {
    case 'text':
    case 'date':
    case 'time':
    case 'datetime':
      return typeof raw === 'string' ? { ok: true, value: raw } : { ok: false };
    case 'number': {
      const wanted = currencyOf(field.unit);
      if (wanted) {
        if (typeof raw !== 'object') return { ok: false };
        const { amount, currency } = raw as { amount?: unknown; currency?: unknown };
        if (typeof amount !== 'number') return { ok: false };
        const stated = typeof currency === 'string' ? currency : null;
        const value = round(amount, field.integer ? 0 : field.decimals);
        if (stated !== null && stated !== wanted) return { ok: false, guess: value, currency: stated };
        return { ok: true, value, currency: stated };
      }
      return typeof raw === 'number' ? { ok: true, value: round(raw, field.integer ? 0 : field.decimals) } : { ok: false };
    }
    case 'duration': {
      if (typeof raw !== 'string') return { ok: false };
      const value = durationIn(raw, field.unit ?? 'seconds');
      if (value === undefined) return { ok: false };
      return { ok: true, value: round(value, field.integer ? 0 : field.decimals) };
    }
    case 'list': {
      if (field.items === 'number') {
        return typeof raw === 'number' ? { ok: true, value: round(raw, field.integer ? 0 : field.decimals) } : { ok: false };
      }
      return typeof raw === 'string' ? { ok: true, value: raw } : { ok: false };
    }
    default:
      return { ok: false };
  }
}

function toAnswer(
  field: ExtractionModelV4Field,
  result: ExtractResult,
  parts: PartSpan[],
): { answer: ExtractionModelV4Answer; currencyCode?: string | null } {
  if (field.type === 'list') {
    const items = 'values' in result && Array.isArray(result.values) ? result.values : [];
    const values: (string | number)[] = [];
    const meta: { confidence?: number; source?: ExtractionModelV4Source }[] = [];
    for (const item of items) {
      const c = convertValue(field, item.value);
      if (!c.ok) continue;
      values.push(c.value);
      meta.push({ confidence: item.probability ?? undefined, source: sourceOf(item, parts) });
    }
    return {
      answer: {
        type: 'list',
        value: values.length > 0 ? (values as string[] | number[]) : null,
        items: values.length > 0 ? meta : undefined,
      },
    };
  }

  const single = result as ExtractCandidate & { probabilities?: ExtractCandidate[] | null };
  const candidates = single.probabilities ?? [];
  const nullEntry = candidates.find(c => c.value == null);
  const pNull = nullEntry?.probability ?? (single.value == null && single.start == null ? single.probability ?? undefined : undefined);

  const converted = convertValue(field, single.value);
  if (converted.ok) {
    return {
      answer: {
        type: field.type,
        value: converted.value,
        guess: converted.value,
        pNull,
        confidence: single.probability ?? undefined,
        source: sourceOf(single, parts),
      } as ExtractionModelV4Answer,
      currencyCode: converted.currency,
    };
  }

  // No value: absent, too close to call, or not in the requested currency.
  let guess = converted.guess;
  let currencyCode = converted.currency;
  let source: ExtractionModelV4Source | undefined;
  if (guess === undefined) {
    const best = candidates
      .filter(c => c.value != null)
      .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))[0];
    if (best) {
      const c = convertValue(field, best.value);
      guess = c.ok ? c.value : c.guess;
      currencyCode = c.currency;
      source = sourceOf(best, parts);
    }
  } else {
    source = sourceOf(single, parts);
  }
  return {
    answer: { type: field.type, value: null, guess, pNull, source } as ExtractionModelV4Answer,
    currencyCode,
  };
}

/** Where a value was read, as a UTF-16 range inside one text part of the state. */
export function sourceOf(candidate: ExtractCandidate, parts: PartSpan[]): ExtractionModelV4Source | undefined {
  const { start, end } = candidate;
  if (start == null || end == null) return undefined;
  const part = parts.find(p => start >= p.start && end <= p.start + p.length);
  if (!part || !part.isText) return undefined;
  return {
    type: 'text',
    part: part.index,
    start: utf16Offset(part.text, start - part.start),
    end: utf16Offset(part.text, end - part.start),
  };
}

// --- helpers -------------------------------------------------------------

export function codePointLength(text: string): number {
  let n = 0;
  for (const _ of text) n++;
  return n;
}

/** UTF-16 offset of the code point at `codePoints` in `text`. */
export function utf16Offset(text: string, codePoints: number): number {
  let units = 0;
  let seen = 0;
  for (const ch of text) {
    if (seen === codePoints) break;
    units += ch.length;
    seen++;
  }
  return units;
}

type DurationParts = { years: number; months: number; weeks: number; days: number; hours: number; minutes: number; seconds: number };

export function parseIsoDuration(iso: string): DurationParts | undefined {
  const t = iso.trim();
  const num = '(\\d+(?:[.,]\\d+)?)';
  const m = new RegExp(`^P(?:${num}Y)?(?:${num}M)?(?:${num}W)?(?:${num}D)?(?:T(?:${num}H)?(?:${num}M)?(?:${num}S)?)?$`).exec(t);
  if (!m || t === 'P' || t.endsWith('T')) return undefined;
  const n = (s?: string) => (s ? Number(s.replace(',', '.')) : 0);
  return { years: n(m[1]), months: n(m[2]), weeks: n(m[3]), days: n(m[4]), hours: n(m[5]), minutes: n(m[6]), seconds: n(m[7]) };
}

/** Seconds in an ISO 8601 duration, with a month as 30 days and a year as 365. */
export function isoDurationSeconds(iso: string): number | undefined {
  const d = parseIsoDuration(iso);
  if (!d) return undefined;
  return (
    d.years * SECONDS.years +
    d.months * SECONDS.months +
    d.weeks * SECONDS.weeks +
    d.days * SECONDS.days +
    d.hours * 3600 +
    d.minutes * 60 +
    d.seconds
  );
}

/** An ISO 8601 duration in `unit`. Years and months convert exactly between each other (12 to a year). */
export function durationIn(iso: string, unit: DurationUnit): number | undefined {
  const d = parseIsoDuration(iso);
  if (!d) return undefined;
  if (unit === 'months' || unit === 'years') {
    const rest = d.weeks * SECONDS.weeks + d.days * SECONDS.days + d.hours * 3600 + d.minutes * 60 + d.seconds;
    const months = d.years * 12 + d.months + rest / SECONDS.months;
    return unit === 'months' ? months : months / 12;
  }
  return isoDurationSeconds(iso)! / SECONDS[unit];
}

function round(value: number, decimals: number | undefined): number {
  if (decimals == null) return value;
  const f = 10 ** decimals;
  return Math.round(value * f) / f;
}
