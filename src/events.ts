export type AgentEvent =
  | { kind: "thinking"; text: string }
  | { kind: "say"; text: string }
  | { kind: "tool"; name: string; input: unknown }
  | { kind: "result"; name: string; output: string }
  | { kind: "turn"; costUsd: number; durationMs: number; error: boolean }
  | { kind: "status"; text: string }
  | { kind: "state"; game: string; state: object };

type Listener = (e: AgentEvent & { at: number }) => void;
const listeners = new Set<Listener>();

export function emit(e: AgentEvent): void {
  const stamped = { ...e, at: Date.now() };
  for (const l of listeners) l(stamped);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
