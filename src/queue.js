export function queueDiameter(queued, scale = 1000) {
  const ratio = Math.max(0, Math.min(1, queued / Math.max(1, scale)));
  return Math.round(34 + 50 * Math.sqrt(ratio));
}

export function queueChange(before, after, tolerance = 0.5) {
  if (after < before - tolerance) return "less";
  if (after > before + tolerance) return "more";
  return "same";
}

export function queueShare(queued, demand) {
  return Math.max(0, Math.min(1, queued / Math.max(demand, 1)));
}

export function approachHeat(hourRank, share) {
  const moving = Math.min(1, Math.max(0, hourRank) * 0.4);
  const queued = Math.max(0, Math.min(1, share));
  return Math.min(1, moving + 0.75 * queued);
}
