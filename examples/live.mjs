// Live check against the Levanto API. Needs LEVANTO_API_KEY. Run after `npm run build`.
import { experimental_decide as decide, experimental_extract as extract, generateText } from 'ai';
import { levanto } from '../dist/index.js';

const d = await decide({
  model: levanto.decisionModel('sage-latest'),
  state: 'I was charged twice for my order. Please refund the duplicate today.',
  questions: {
    refund: { type: 'boolean', instructions: 'Is the customer asking for money back?' },
    team: { type: 'choice', criteria: { billing: 'Charges and refunds', technical: 'Bugs and outages', other: null } },
    urgency: { type: 'score', criteria: ['Can wait', 'This week', 'Today'] },
  },
});
console.log('decide', JSON.stringify({ answers: d.answers, usage: d.usage, meta: d.providerMetadata }));

const text = '😀 Acme Corp. signed a three (3) year lease with Beacon Realty on 2 May 2026. Rent 1.930,78 € per month. Contacts: Dana Ruiz, Priya Shah.';
const e = await extract({
  model: levanto.extractionModel('sage-latest'),
  state: text,
  fields: {
    tenant: { type: 'text', instructions: 'The company renting' },
    term: { type: 'duration', unit: 'months', integer: true },
    signed: { type: 'date' },
    rent: { type: 'number', unit: 'EUR' },
    rentUsd: { type: 'number', unit: 'USD' },
    spaces: { type: 'number', integer: true, instructions: 'Number of parking spaces' },
    contacts: { type: 'list', items: 'text', instructions: 'A contact person' },
  },
});
for (const [k, a] of Object.entries(e.answers)) {
  const src = a.source ? text.slice(a.source.start, a.source.end) : a.items?.map(i => text.slice(i.source.start, i.source.end));
  console.log('extract', k, JSON.stringify({ value: a.value, guess: a.guess, pNull: a.pNull, confidence: a.confidence, src }));
}
console.log('extract meta', JSON.stringify(e.providerMetadata), JSON.stringify(e.usage), e.warnings.length);

const g = await generateText({ model: levanto('auto'), prompt: 'Reply with the single word ok.', providerOptions: { levanto: { target: 'economy' } } });
console.log('chat', JSON.stringify(g.text), g.response.modelId, JSON.stringify(g.usage));
