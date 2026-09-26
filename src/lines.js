export function extraShift(plan, active) {
  const table = plan?.extraShift || { verde: 0.08, gialla: 0.08, blu: 0.1 };
  return ["verde", "gialla", "blu"].reduce((sum, id) => sum + (active.includes(id) ? table[id] || 0 : 0), 0);
}

export function withLines(pair, active = ["rossa"], plan = null) {
  const shift = Math.min(0.5, extraShift(plan, active));
  const chosen = active.includes("rossa") ? pair.after : pair.before;
  return {
    ...pair,
    after: {
      ...chosen,
      carFlow: chosen.carFlow * (1 - shift),
    },
  };
}
