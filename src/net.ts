export const REQUEST_MS = 30_000;
export const INCLUSION_MS = 300_000;
const RATE_RETRIES = 5;
const RATE_LIMITED = /"code"\s*:\s*-32005/;

export async function request(url: string | URL | Request, init?: RequestInit, attempt = 0): Promise<Response> {
  const res = await fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
  if (attempt >= RATE_RETRIES || (res.status !== 429 && !RATE_LIMITED.test(await res.clone().text()))) return res;
  await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
  return request(url, init, attempt + 1);
}
