export type AgentEvent =
  | { kind: "decision"; phase: string; options: unknown[]; thought: string; actions: unknown[]; note: string; reserve: number; costUsd: number }
  | { kind: "rejected"; actions: unknown[]; reason: string }
  | { kind: "preview"; actions: unknown; result: string }
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
