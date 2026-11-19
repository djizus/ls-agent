export const summary = (levels: number[]) => {
  const sorted = [...levels].sort((a, b) => a - b);
  const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
  const se = Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / (levels.length - 1) / levels.length);
  const share = (n: number) => +((100 * levels.filter((l) => l >= n).length) / levels.length).toFixed(1);
  return { games: levels.length, mean: +mean.toFixed(2), se: +se.toFixed(2), median: sorted[sorted.length >> 1], "26+": share(26), "30+": share(30), "35+": share(35), "40+": share(40), "45+": share(45), best: sorted.at(-1) };
};
