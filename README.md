# Levanto provider for the AI SDK

[Levanto](https://levanto.ai) for the [Vercel AI SDK](https://ai-sdk.dev): Sage for typed decisions and extraction, and Levanto's LLMs with a router that picks the model per request.

```bash
npm install ai @levanto/ai-sdk-provider
```

Set `LEVANTO_API_KEY` ([create a key](https://platform.levanto.ai)).

## Decisions

```ts
import { experimental_decide as decide } from 'ai';
import { levanto } from '@levanto/ai-sdk-provider';

const { answers } = await decide({
  model: levanto.decisionModel('sage-latest'),
  state: 'I was charged twice. Please refund the duplicate today.',
  questions: {
    refund: { type: 'boolean', instructions: 'Is the customer asking for money back?' },
    team: { type: 'choice', criteria: { billing: 'Charges and refunds', technical: 'Bugs and outages' } },
    urgency: { type: 'score', criteria: ['Can wait', 'This week', 'Today'] },
  },
});

answers.refund.probability; // 0.997
answers.team.choice;        // 'billing'
answers.urgency.score;      // 1.98, from 0 to 2
```

A choice takes 2 to 256 options, a score 2 to 26 levels, a call up to 64 questions. Every answer comes back: pick your own threshold on `probability`. To get `null` when Sage isn't sure, call [`POST /decide`](https://docs.levanto.ai/decision-model/quickstart) directly.

Sage options go in `providerOptions.levanto`: `reasoning` (`off`, `auto`, `on`), `grounding`, `tags` and `sort`, as in the [SystemOne API](https://docs.levanto.ai/systemone). The call's `reasoning` maps to `off` for `'none'` and `on` for any effort. Extra answers (a sort, a tag set) and each answer's `confidence` are in `providerMetadata.levanto`.

## Extraction

```ts
import { experimental_extract as extract } from 'ai';
import { levanto } from '@levanto/ai-sdk-provider';

const { answers } = await extract({
  model: levanto.extractionModel('sage-latest'),
  state: 'Acme Corp. signed a three (3) year lease on 2 May 2026. Rent 1.930,78 € per month.',
  fields: {
    tenant: { type: 'text', instructions: 'The company renting' },
    term: { type: 'duration', unit: 'months', integer: true },
    signed: { type: 'date' },
    rent: { type: 'number', unit: 'EUR' },
  },
});

answers.term.value; // 36
answers.rent.value; // 1930.78
```

Each answer has `value` (`null` when the text doesn't state it), `guess`, `pNull`, `confidence` and `source`. A number with a currency `unit` (`USD`, `EUR`, `$`, `€`…) is read as money: an amount stated in another currency gives `value: null`, the amount in `guess` and the stated currency in `providerMetadata.levanto.currency`. Other units are ignored. Sage reads only what the text states, so `referenceDate` is ignored too. Files and images aren't supported through the AI SDK.

## LLMs

```ts
import { generateText } from 'ai';
import { levanto } from '@levanto/ai-sdk-provider';

const { text, response } = await generateText({
  model: levanto('auto'),
  prompt: 'Summarize this ticket in one sentence: ...',
  providerOptions: { levanto: { target: 'economy' } }, // economy, balanced or quality
});

response.modelId; // the model the router picked
```

Pin a model with any id from `GET https://api.levanto.ai/v1/models`.

## Settings

```ts
import { createLevanto } from '@levanto/ai-sdk-provider';

const levanto = createLevanto({ apiKey: process.env.MY_KEY });
```

| Setting | Default |
|---|---|
| `apiKey` | `LEVANTO_API_KEY` |
| `baseURL` | `LEVANTO_BASE_URL`, then `https://api.levanto.ai` |
| `headers` | none |
| `fetch` | `globalThis.fetch` |

The decision and extraction APIs are experimental in the AI SDK and may change in its patch releases.

## Docs

[docs.levanto.ai](https://docs.levanto.ai)

## License

MIT
