export const summary = (levels: number[]) => {
  const sorted = [...levels].sort((a, b) => a - b);
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const se = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / (levels.length - 1) / levels.length);
  const share = (n: number) => +((100 * levels.filter((l) => l >= n).length) / levels.length).toFixed(1);
  return { games: levels.length, mean: +mean.toFixed(2), se: +se.toFixed(2), median: sorted[sorted.length >> 1], "26+": share(26), "30+": share(30), "35+": share(35), "40+": share(40), "45+": share(45), best: sorted.at(-1) };
};

export type Ended = { id: number; mode: string; level: number; beasts: number | null; claimed: number | null; gas_strk: number | null; survivor: number | null };

export const ENDED = "SELECT id, mode, level, beasts, claimed, gas_strk, survivor FROM games WHERE ended_at IS NOT NULL ORDER BY id DESC";

export function dungeonFigures(ended: Ended[], dungeons: Record<string, { name: string }>) {
  const mean = (values: number[]) => (values.length ? summary(values).mean : null);
  return Object.entries(dungeons).map(([mode, d]) => {
    const games = ended.filter((g) => g.mode === mode);
    if (!games.length) return { mode, name: d.name, games: 0 };
    const record = games.reduce((a, b) => (b.level > a.level || (b.level === a.level && (b.beasts ?? 0) > (a.beasts ?? 0)) ? b : a));
    return {
      mode,
      name: d.name,
      games: games.length,
      mean: mean(games.map((g) => g.level)),
      best: record.level,
      slain: mean(games.flatMap((g) => (g.beasts === null ? [] : [g.beasts]))),
      claimed: games.reduce((sum, g) => sum + (g.claimed ?? 0), 0),
      record: { id: record.id, level: record.level, beasts: record.beasts ?? 0 },
    };
  });
}
