import { generateText, Output } from 'ai';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { createLevanto } from '../src';
import { KEY, mockFetch } from './helpers';

const completion = {
  id: 'c1',
  object: 'chat.completion',
  created: 1764000000,
  model: 'deepseek/deepseek-v4-flash',
  choices: [{ index: 0, message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }],
  usage: { prompt_tokens: 10, completion_tokens: 1, total_tokens: 11 },
};

describe('language model', () => {
  it('calls /v1/chat/completions with the key and router options', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: completion }));
    const levanto = createLevanto({ apiKey: KEY, fetch });
    const result = await generateText({
      model: levanto('auto'),
      prompt: 'Reply with the word ok.',
      providerOptions: { levanto: { target: 'economy' } },
    });
    expect(calls[0].url).toBe('https://api.levanto.ai/v1/chat/completions');
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers.get('user-agent')).toMatch(/ai-sdk\/levanto\//);
    expect(calls[0].body).toMatchObject({ model: 'auto', target: 'economy' });
    expect(result.text).toBe('ok');
    expect(result.response.modelId).toBe('deepseek/deepseek-v4-flash');
  });

  it('sends the JSON schema for structured output', async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: { ...completion, choices: [{ ...completion.choices[0], message: { role: 'assistant', content: '{"name":"Rome"}' } }] },
    }));
    const result = await generateText({
      model: createLevanto({ apiKey: KEY, fetch })('auto'),
      prompt: 'A city.',
      output: Output.object({ schema: z.object({ name: z.string() }) }),
    });
    expect(calls[0].body.response_format).toMatchObject({ type: 'json_schema', json_schema: { schema: { type: 'object' } } });
    expect(result.output).toEqual({ name: 'Rome' });
  });

  it('honours LEVANTO_BASE_URL', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: completion }));
    process.env.LEVANTO_BASE_URL = 'https://example.test/';
    try {
      await generateText({ model: createLevanto({ apiKey: KEY, fetch }).chatModel('auto'), prompt: 'x' });
    } finally {
      delete process.env.LEVANTO_BASE_URL;
    }
    expect(calls[0].url).toBe('https://example.test/v1/chat/completions');
  });
});
