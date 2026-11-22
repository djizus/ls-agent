import type { dungeonFigures } from "./summary.ts";

type Baseline = { games?: number; mean: number; "30+": number; named?: number };
type Figures = ReturnType<typeof dungeonFigures>[number];

const HEADING = "## Results";
const n = (value: number | null | undefined, digits = 1) => (value == null ? "-" : value.toLocaleString("en", { maximumFractionDigits: digits }));

export const benchTable = (baselines: Record<string, Baseline>, names: Record<string, { name: string }>): string[] => [
  "| Dungeon | Games | Average level | Reach level 30 | Named beasts a game |",
  "|---|---|---|---|---|",
  ...Object.entries(baselines).map(([mode, b]) => `| ${names[mode]?.name ?? mode} | ${n(b.games, 0)} | ${n(b.mean)} | ${n(b["30+"])}% | ${n(b.named)} |`),
];

export function resultsSection(date: string, baselines: Record<string, Baseline>, real: Figures[], names: Record<string, { name: string }>): string {
  const games = real.map((f) => (f.record ? `| ${f.name} | ${n(f.games, 0)} | ${n(f.mean)} | ${f.best} | ${n(f.slain)} | ${n(f.claimed, 0)} | level ${f.record.level}, ${f.record.beasts} named beasts |` : `| ${f.name} | 0 | - | - | - | - | - |`));
  return [
    HEADING,
    "",
    `As of ${date}. \`npm run stats\` writes this section.`,
    "",
    "How the rules play on the local copy of the game, where games cost nothing:",
    "",
    ...benchTable(baselines, names),
    "",
    "How the real games went:",
    "",
    "| Dungeon | Games | Average level | Best level | Named beasts a game | Beasts claimed | Record game |",
    "|---|---|---|---|---|---|---|",
    ...games,
    "",
  ].join("\n");
}

export function withResults(readme: string, section: string): string {
  const start = readme.indexOf(`\n${HEADING}\n`);
  if (start < 0) {
    const before = readme.indexOf("\n## Run it yourself\n");
    if (before < 0) throw new Error("README.md has no Results section and no Run it yourself section to put it before");
    return `${readme.slice(0, before + 1)}${section}\n${readme.slice(before + 1)}`;
  }
  const next = readme.indexOf("\n## ", start + 1);
  return `${readme.slice(0, start + 1)}${section}${next < 0 ? "" : `\n${readme.slice(next + 1)}`}`;
}
