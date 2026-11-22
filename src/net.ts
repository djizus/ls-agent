export const REQUEST_MS = 30_000;
export const INCLUSION_MS = 300_000;

export const request = (url: string | URL | Request, init?: RequestInit): Promise<Response> => fetch(url, { ...init, signal: AbortSignal.timeout(REQUEST_MS) });
