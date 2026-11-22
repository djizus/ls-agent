import { fork, type Serializable } from "node:child_process";
import { availableParallelism, constants, setPriority } from "node:os";

export const PROCS = String(Math.max(1, Math.min(12, availableParallelism() - 2)));

export function spread<T, R>(items: T[], procs: number, message: (share: T[]) => Serializable = (share) => share as Serializable): Promise<R[]> {
  return Promise.all(
    Array.from({ length: procs }, (_, share) => new Promise<R>((resolve, reject) => {
      const child = fork(process.argv[1], process.argv.slice(2));
      child.once("message", (m) => resolve(m as R));
      child.once("exit", (code) => code && reject(new Error(`worker ${share} exited with ${code}`)));
      child.send(message(items.filter((_, i) => i % procs === share)));
    })),
  );
}

export function serve<T>(work: (message: T) => Promise<unknown>): void {
  setPriority(constants.priority.PRIORITY_LOW);
  process.once("message", async (m: T) => process.send!(await work(m)));
}
