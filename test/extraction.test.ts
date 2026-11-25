import { experimental_extract as extract } from 'ai';
import { describe, expect, it } from 'vitest';
import { createLevanto } from '../src';
import { codePointLength, isoDurationSeconds, utf16Offset } from '../src/levanto-extraction-model';
import { KEY, mockFetch } from './helpers';

// A real /v1/extract response shape (2026-11-25), offsets in code points.
const TEXT = '😀 Acme Corp. signed a three (3) year lease with Beacon Realty on 2 May 2026. Rent 1.930,78 € per month. Contacts: Dana Ruiz, Priya Shah.';
const cand = (value: unknown, text: string, probability: number) => {
  const start = [...TEXT].join('').indexOf(text); // UTF-16 index
  const cpStart = codePointLength(TEXT.slice(0, start));
  return { value, text, start: cpStart, end: cpStart + codePointLength(text), probability };
};
const single = (c: ReturnType<typeof cand>, pNull: number) => ({ ...c, probabilities: [c, { value: null, probability: pNull }] });

const responseBody = {
  values: {},
  results: {
    tenant: single(cand('Acme Corp.', 'Acme Corp.', 0.99), 0.01),
    term: single(cand('P3Y', 'three (3) year', 0.81), 0.19),
    signed: single(cand('2026-05-02', '2 May 2026', 0.77), 0.23),
    rent: single(cand({ amount: 1930.78, currency: 'EUR' }, '1.930,78 €', 0.86), 0.14),
    rentUsd: single(cand({ amount: 1930.78, currency: 'EUR' }, '1.930,78 €', 0.86), 0.14),
    spaces: { value: null, text: null, start: null, end: null, probability: 1.0, probabilities: [{ value: null, probability: 1.0 }] },
    close: {
      value: null,
      text: null,
      start: null,
      end: null,
      probability: null,
      probabilities: [cand('Beacon Realty', 'Beacon Realty', 0.45), { value: null, probability: 0.55 }],
    },
    contacts: { values: [cand('Dana Ruiz', 'Dana Ruiz', 0.67), cand('Priya Shah', 'Priya Shah', 0.59)] },
    amounts: { values: [] },
  },
  meta: { model: 'levanto-sage-2', usage: { input_tokens: 272, output_tokens: 551 } },
};

describe('extractionModel', () => {
  it('maps fields to /v1/extract and answers back to AI SDK types', async () => {
    const { fetch, calls } = mockFetch(() => ({ body: responseBody }));
    const levanto = createLevanto({ apiKey: KEY, fetch });
    const result = await extract({
      model: levanto.extractionModel('sage-latest'),
      state: TEXT,
      fields: {
        tenant: { type: 'text', instructions: 'The company renting' },
        term: { type: 'duration', unit: 'months', integer: true },
        signed: { type: 'date' },
        rent: { type: 'number', unit: 'EUR', decimals: 2 },
        rentUsd: { type: 'number', unit: 'USD' },
        spaces: { type: 'number', integer: true, instructions: 'Parking spaces' },
        close: { type: 'text', instructions: 'The landlord' },
        contacts: { type: 'list', items: 'text', instructions: 'A contact person' },
        amounts: { type: 'list', items: 'number' },
      },
    });

    expect(calls[0].url).toBe('https://api.levanto.ai/v1/extract');
    expect(calls[0].body).toEqual({
      content: TEXT,
      extract: {
        tenant: { type: 'text', definition: 'The company renting' },
        term: { type: 'duration', definition: '' },
        signed: { type: 'date', definition: '' },
        rent: { type: 'money', definition: '' },
        rentUsd: { type: 'money', definition: '' },
        spaces: { type: 'integer', definition: 'Parking spaces' },
        close: { type: 'text', definition: 'The landlord' },
        contacts: [{ type: 'text', definition: 'A contact person' }],
        amounts: [{ type: 'decimal', definition: '' }],
      },
    });

    const a = result.answers as Record<string, any>;
    expect(a.tenant).toMatchObject({ value: 'Acme Corp.', confidence: 0.99, pNull: 0.01 });
    // Source offsets are UTF-16, so they slice the original string.
    const src = a.tenant.source;
    expect(src).toMatchObject({ type: 'text', part: 0 });
    expect(TEXT.slice(src.start, src.end)).toBe('Acme Corp.');

    expect(a.term.value).toBe(36);
    expect(a.signed.value).toBe('2026-05-02');
    expect(a.rent.value).toBe(1930.78);
    // Stated in EUR, asked in USD: no value, the amount as a guess.
    expect(a.rentUsd).toMatchObject({ value: null, guess: 1930.78 });
    expect(result.providerMetadata?.levanto?.currency).toEqual({ rent: 'EUR', rentUsd: 'EUR' });
    expect(a.spaces).toMatchObject({ value: null, pNull: 1.0 });
    expect(a.close).toMatchObject({ value: null, guess: 'Beacon Realty', pNull: 0.55 });
    expect(a.contacts.value).toEqual(['Dana Ruiz', 'Priya Shah']);
    expect(TEXT.slice(a.contacts.items[1].source.start, a.contacts.items[1].source.end)).toBe('Priya Shah');
    expect(a.amounts.value).toBeNull();
    expect(result.usage).toMatchObject({ inputTokens: 272, outputTokens: 551 });
  });

  it('points sources at the right part of a multi-part state', async () => {
    const parts = ['First note 🎉 nothing here.', 'Second note: invoice INV-7 due.'];
    const joined = parts.join('\n\n');
    const at = codePointLength(joined.slice(0, joined.indexOf('INV-7')));
    const { fetch } = mockFetch(() => ({
      body: {
        values: {},
        results: { inv: { value: 'INV-7', text: 'INV-7', start: at, end: at + 5, probability: 0.9, probabilities: [] } },
      },
    }));
    const result = await extract({
      model: createLevanto({ apiKey: KEY, fetch }).extractionModel('sage-latest'),
      state: [
        { type: 'text', text: parts[0] },
        { type: 'text', text: parts[1] },
      ],
      fields: { inv: { type: 'text' } },
    });
    const src = (result.answers as any).inv.source;
    expect(src.part).toBe(1);
    expect(parts[1].slice(src.start, src.end)).toBe('INV-7');
  });

  it('warns about what Levanto ignores', async () => {
    const { fetch } = mockFetch(() => ({
      body: { values: {}, results: { w: { value: 70, text: '70 kg', start: 0, end: 5, probability: 0.9, probabilities: [] } } },
    }));
    const result = await extract({
      model: createLevanto({ apiKey: KEY, fetch }).extractionModel('sage-latest'),
      state: '70 kg',
      referenceDate: '2026-11-25',
      fields: { w: { type: 'number', unit: 'kg' } },
    });
    const features = result.warnings.map(w => ('feature' in w ? w.feature : ''));
    expect(features).toEqual(expect.arrayContaining(['referenceDate', 'fields.w.unit']));
  });
});

describe('helpers', () => {
  it('converts ISO durations', () => {
    expect(isoDurationSeconds('P3Y')).toBe(3 * 365 * 86400);
    expect(isoDurationSeconds('PT45M')).toBe(2700);
    expect(isoDurationSeconds('P1DT1H')).toBe(90000);
    expect(isoDurationSeconds('P0.5D')).toBe(43200);
    expect(isoDurationSeconds('P')).toBeUndefined();
    expect(isoDurationSeconds('three years')).toBeUndefined();
  });
  it('converts code points to UTF-16 offsets', () => {
    expect(utf16Offset('😀 a', 2)).toBe(3);
    expect(utf16Offset('abc', 2)).toBe(2);
  });
});

describe('durations in calendar units', () => {
  it('keeps 12 months to a year', async () => {
    const { durationIn } = await import('../src/levanto-extraction-model');
    expect(durationIn('P3Y', 'months')).toBe(36);
    expect(durationIn('P18M', 'years')).toBe(1.5);
    expect(durationIn('P1Y', 'days')).toBe(365);
    expect(durationIn('PT90M', 'hours')).toBe(1.5);
  });
});
