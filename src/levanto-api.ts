import { createJsonErrorResponseHandler } from '@ai-sdk/provider-utils';
import * as z from 'zod/v4';

/**
 * Levanto errors are either `application/problem+json` (`title`, `detail`,
 * `code`) or a validation body whose `detail` is a list of `{ msg }`.
 */
const levantoErrorSchema = z.looseObject({
  title: z.string().nullish(),
  detail: z.unknown().nullish(),
  code: z.string().nullish(),
  message: z.string().nullish(),
});

export type LevantoErrorData = z.infer<typeof levantoErrorSchema>;

export function levantoErrorMessage(error: LevantoErrorData): string {
  const { detail } = error;
  let text: string | undefined;
  if (typeof detail === 'string') {
    text = detail;
  } else if (Array.isArray(detail)) {
    const parts = detail
      .map(d => (d && typeof d === 'object' && 'msg' in d ? String((d as { msg: unknown }).msg) : undefined))
      .filter((m): m is string => !!m);
    if (parts.length > 0) text = parts.join('; ');
  }
  text ??= error.message ?? error.title ?? undefined;
  if (text && error.code) return `${text} (${error.code})`;
  return text ?? error.code ?? 'Levanto request failed';
}

export const levantoFailedResponseHandler = createJsonErrorResponseHandler({
  errorSchema: levantoErrorSchema,
  errorToMessage: levantoErrorMessage,
});

const anyAnswer = z.looseObject({ type: z.string() });

export const systemOneResponseSchema = z.looseObject({
  model: z.string().nullish(),
  answers: z.record(z.string(), anyAnswer),
  annotations: z.array(z.unknown()).nullish(),
  usage: z
    .looseObject({
      input_tokens: z.number().nullish(),
      output_tokens: z.number().nullish(),
    })
    .nullish(),
});

export type SystemOneResponse = z.infer<typeof systemOneResponseSchema>;

const extractCandidate = z.looseObject({
  value: z.unknown(),
  text: z.string().nullish(),
  start: z.number().nullish(),
  end: z.number().nullish(),
  probability: z.number().nullish(),
});

export type ExtractCandidate = z.infer<typeof extractCandidate>;

const extractResult = z.union([
  z.looseObject({ values: z.array(extractCandidate) }),
  extractCandidate.extend({
    probabilities: z.array(extractCandidate).nullish(),
    parse_error: z.unknown().nullish(),
  }),
]);

export type ExtractResult = z.infer<typeof extractResult>;

export const extractResponseSchema = z.looseObject({
  values: z.record(z.string(), z.unknown()),
  results: z.record(z.string(), extractResult),
  meta: z
    .looseObject({
      model: z.string().nullish(),
      usage: z
        .looseObject({
          input_tokens: z.number().nullish(),
          output_tokens: z.number().nullish(),
        })
        .nullish(),
    })
    .nullish(),
});

export type ExtractResponse = z.infer<typeof extractResponseSchema>;
