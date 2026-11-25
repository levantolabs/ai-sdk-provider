export type Call = { url: string; headers: Headers; body: any };

/** A fetch that records each call and answers with `respond(call)`. */
export function mockFetch(respond: (call: Call) => { status?: number; body: unknown; headers?: Record<string, string> }) {
  const calls: Call[] = [];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      headers: new Headers(init?.headers),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    };
    calls.push(call);
    const r = respond(call);
    return new Response(JSON.stringify(r.body), {
      status: r.status ?? 200,
      headers: { 'content-type': 'application/json', ...r.headers },
    });
  };
  return { fetch: fetch as typeof globalThis.fetch, calls };
}

export const KEY = 'lv_live_' + '0123456789abcdef'.repeat(3);
