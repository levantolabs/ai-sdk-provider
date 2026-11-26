# Changelog

## 0.1.1 (2026-11-26)

- Structured output (`Output.object`, `generateObject`) now sends the JSON schema to Levanto, so the answer matches it.

## 0.1.0 (2026-11-25)

First release.

- `levanto(modelId)`: Levanto's LLMs for `generateText`, `streamText` and the rest. `auto` lets the router pick.
- `levanto.decisionModel('sage-latest')`: Sage for `experimental_decide` (boolean, choice, score).
- `levanto.extractionModel('sage-latest')`: Sage for `experimental_extract` (text, number, date, time, datetime, duration, list).
