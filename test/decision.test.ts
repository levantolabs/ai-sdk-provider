import { experimental_decide as decide } from 'ai';
import { describe, expect, it } from 'vitest';
import { createLevanto } from '../src';
import { KEY, mockFetch } from './helpers';

const okBody = {
  model: 'levanto-sage-2',
  answers: {
    refund: { type: 'noul', noul: 0.97, confidence: 0.97 },
    team: { type: 'choice', choice: 'billing', confidence: 0.9, probabilities: { billing: 0.9, technical: 0.1 } },
    urgency: {
      type: 'score',
      score: 1.6,
      confidence: 0.66,
      legend: { '0': 'Can wait', '1': 'This week', '2': 'Today' },
      probabilities: { '0': 0.06, '1': 0.28, '2': 0.66 },
    },
  },
  usage: { input_tokens: 202, output_tokens: 0 },
};

const questions = {
  refund: { type: 'boolean', instructions: 'Is the customer asking for money back?' },
  team: { type: 'choice', criteria: { billing: 'Charges and refunds', technical: null } },
  urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Can wait', 'This week', 'Today'] },
} as const;

describe('decisionModel', () => {
  it('sends SystemOne and maps the answers', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: okBody }));
    const levanto = createLevanto({ apiKey: KEY, fetch });
    const result = await decide({
      model: levanto.decisionModel('sage-latest'),
      state: 'I was charged twice. Please refund the duplicate.',
      questions,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://api.levanto.ai/v1/systemone');
    expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0].headers.get('user-agent')).toMatch(/ai-sdk\/levanto\//);
    expect(calls[0].body).toEqual({
      model: 'sage-latest',
      state: 'I was charged twice. Please refund the duplicate.',
      questions: {
        refund: { type: 'noul', instructions: 'Is the customer asking for money back?' },
        team: { type: 'choice', criteria: { billing: 'Charges and refunds', technical: null } },
        urgency: { type: 'score', instructions: 'How urgent?', criteria: ['Can wait', 'This week', 'Today'] },
      },
    });

    expect(result.answers.refund).toMatchObject({ probability: 0.97 });
    expect(result.answers.team).toMatchObject({ choice: 'billing' });
    expect(result.answers.urgency).toMatchObject({ score: 1.6 });
    expect(result.usage).toMatchObject({ inputTokens: 202, outputTokens: 0 });
    expect(result.providerMetadata?.levanto?.confidence).toEqual({ refund: 0.97, team: 0.9, urgency: 0.66 });
  });

  it('sends a JSON object state as is, and boolean criteria', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: { answers: { spam: { type: 'noul', noul: 0.1 } } } }));
    const levanto = createLevanto({ apiKey: KEY, fetch });
    await decide({
      model: levanto.decisionModel('sage-latest'),
      state: { subject: 'Hello', body: 'Win a prize' },
      questions: { spam: { type: 'boolean', criteria: { true: 'Unsolicited bulk mail' } } },
    });
    expect(calls[0].body.state).toEqual({ subject: 'Hello', body: 'Win a prize' });
    expect(calls[0].body.questions.spam).toEqual({ type: 'noul', criteria: { true: 'Unsolicited bulk mail' } });
  });

  it('maps reasoning and passes Levanto options; extra answers go to metadata', async () => {
    const { fetch, calls } = mockFetch(() => ({
      body: {
        answers: {
          refund: { type: 'noul', noul: 0.9 },
          priority: { type: 'sort', sorted: ['t2', 't1'], confidence: 0.7 },
        },
        annotations: [{ type: 'url_citation', url: 'https://example.com' }],
      },
    }));
    const levanto = createLevanto({ apiKey: KEY, fetch });
    const model = levanto.decisionModel('sage-latest');

    await decide({ model, state: 'x', questions: { refund: questions.refund }, reasoning: 'none' });
    expect(calls[0].body.provider).toEqual({ options: { levanto: { reasoning: 'off' } } });

    const result = await decide({
      model,
      state: 'x',
      questions: { refund: questions.refund },
      reasoning: 'high',
      providerOptions: {
        levanto: {
          reasoning: 'auto',
          grounding: { refund: { trigger: 'always', max_results: 3 } },
          sort: { priority: { items: 'tickets', instructions: 'Most urgent first' } },
        },
      },
    });
    expect(calls[1].body.provider.options.levanto).toEqual({
      reasoning: 'auto',
      grounding: { refund: { trigger: 'always', max_results: 3 } },
      sort: { priority: { items: 'tickets', instructions: 'Most urgent first' } },
    });
    expect(Object.keys(result.answers)).toEqual(['refund']);
    expect(result.providerMetadata?.levanto?.answers).toEqual({
      priority: { type: 'sort', sorted: ['t2', 't1'], confidence: 0.7 },
    });
    expect(result.providerMetadata?.levanto?.annotations).toHaveLength(1);
  });

  it('rejects what Levanto cannot take, before any request', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: okBody }));
    const model = createLevanto({ apiKey: KEY, fetch }).decisionModel('sage-latest');
    await expect(
      decide({ model, state: 'x', questions: { q: { type: 'score', criteria: ['low', null, 'high'] } } }),
    ).rejects.toThrow(/2 to 26 levels/);
    await expect(decide({ model, state: 'x', questions: { q: { type: 'box', instructions: 'Where?' } } })).rejects.toThrow();
    await expect(
      decide({
        model,
        state: [{ type: 'file', mediaType: 'image/png', data: new Uint8Array([1, 2, 3]) }],
        questions: { refund: questions.refund },
      }),
    ).rejects.toThrow(/images/);
    expect(calls).toHaveLength(0);
  });

  it('turns Levanto error bodies into readable messages', async () => {
    const levanto = (status: number, body: unknown) =>
      createLevanto({ apiKey: KEY, fetch: mockFetch(() => ({ status, body })).fetch }).decisionModel('sage-latest');
    const call = (status: number, body: unknown) =>
      decide({ model: levanto(status, body), state: 'x', questions: { refund: questions.refund }, maxRetries: 0 });

    await expect(call(401, { title: 'Unauthorized', detail: 'Invalid API key', code: 'invalid_api_key' })).rejects.toThrow(
      'Invalid API key (invalid_api_key)',
    );
    await expect(
      call(422, { detail: [{ loc: ['body', 'model'], msg: "unknown model 'nope'", type: 'value_error' }] }),
    ).rejects.toThrow("unknown model 'nope'");
  });

  it('reads the key from LEVANTO_API_KEY at call time', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: okBody }));
    const model = createLevanto({ fetch }).decisionModel('sage-latest');
    const before = process.env.LEVANTO_API_KEY;
    delete process.env.LEVANTO_API_KEY;
    await expect(decide({ model, state: 'x', questions, maxRetries: 0 })).rejects.toThrow(/LEVANTO_API_KEY/);
    process.env.LEVANTO_API_KEY = KEY;
    try {
      await decide({ model, state: 'x', questions });
      expect(calls[0].headers.get('authorization')).toBe(`Bearer ${KEY}`);
    } finally {
      if (before === undefined) delete process.env.LEVANTO_API_KEY;
      else process.env.LEVANTO_API_KEY = before;
    }
  });
});
