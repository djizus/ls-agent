export type AgentEvent = (
  | { kind: "decision"; phase: string; options: unknown[]; thought: string; actions: unknown[]; note: string; reserve: number; costUsd: number }
  | { kind: "rejected"; actions: unknown[]; reason: string }
  | { kind: "preview"; actions: unknown; result: string }
  | { kind: "status"; text: string; ending?: string }
  | { kind: "state"; game: string; state: object }
) & { row?: number };

type Listener = (e: AgentEvent & { at: number }) => void;
const listeners = new Set<Listener>();

let last = 0;
const live = new Set<number>();

export const liveRows = (): number[] => [...live];

export function emit(e: AgentEvent): void {
  last = Math.max(Date.now(), last + 1);
  if (e.kind === "status" && e.row !== undefined) e.ending === undefined ? live.add(e.row) : live.delete(e.row);
  const stamped = { ...e, at: last };
  for (const l of listeners) l(stamped);
}

export function subscribe(l: Listener): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
