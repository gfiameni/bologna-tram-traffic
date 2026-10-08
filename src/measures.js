export function centroid(points) {
  if (!points?.length) return null;
  return {
    lat: points.reduce((sum, point) => sum + point.lat, 0) / points.length,
    lon: points.reduce((sum, point) => sum + point.lon, 0) / points.length,
  };
}

function metres(a, b) {
  const dx = (a.lon - b.lon) * Math.cos((a.lat * Math.PI) / 180) * 111320;
  const dy = (a.lat - b.lat) * 110540;
  return Math.hypot(dx, dy);
}

/** One anchor per place, on its own streets, as far as possible from anchors already placed. */
export function pickAnchors(places, obstacles = []) {
  const centre = centroid(places.find((place) => place.id === "centre")?.samples || []);
  const placed = [...obstacles];
  const anchors = {};
  for (const place of places) {
    if (!place.samples?.length) continue;
    if (place.id === "centre" && centre) {
      anchors.centre = centre;
      placed.push(centre);
      continue;
    }
    let candidates = place.samples;
    if (place.line && centre) {
      const far = Math.max(...place.samples.map((sample) => metres(sample, centre)));
      const middle = place.samples.filter((sample) => {
        const distance = metres(sample, centre);
        return distance > 0.35 * far && distance < 0.8 * far;
      });
      if (middle.length) candidates = middle;
    }
    let best = candidates[0];
    let bestGap = -1;
    for (const sample of candidates) {
      const gap = placed.length ? Math.min(...placed.map((point) => metres(sample, point))) : 0;
      if (gap > bestGap) {
        best = sample;
        bestGap = gap;
      }
    }
    anchors[place.id] = { lat: best.lat, lon: best.lon };
    placed.push(best);
  }
  return anchors;
}

/** Push overlapping label boxes apart. Boxes are centred on x, y. Fixed boxes do not move. */
export function spreadBoxes(boxes, fixed = [], iterations = 60, pad = 6) {
  for (let round = 0; round < iterations; round++) {
    let moved = false;
    const push = (a, b, share) => {
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      const overlapX = (a.w + b.w) / 2 + pad - Math.abs(dx);
      const overlapY = (a.h + b.h) / 2 + pad - Math.abs(dy);
      if (overlapX <= 0 || overlapY <= 0) return;
      moved = true;
      if (overlapX < overlapY) {
        const step = (dx >= 0 ? -1 : 1) * overlapX;
        a.x += step * share;
        if (share < 1) b.x -= step * (1 - share);
      } else {
        const step = (dy >= 0 ? -1 : 1) * overlapY;
        a.y += step * share;
        if (share < 1) b.y -= step * (1 - share);
      }
    };
    for (let i = 0; i < boxes.length; i++) {
      for (let j = i + 1; j < boxes.length; j++) push(boxes[i], boxes[j], 0.5);
      for (const block of fixed) push(boxes[i], block, 1);
    }
    if (!moved) break;
  }
  return boxes;
}

export function measureDiameter(value, scale, min = 30, span = 34) {
  const ratio = Math.max(0, Math.min(1, value / Math.max(scale, 1)));
  return Math.round(min + span * Math.sqrt(ratio));
}

export function levelBand(level) {
  if (level > 0.72) return "peak";
  if (level > 0.52) return "high";
  if (level > 0.36) return "mid";
  return "low";
}

export function percentChange(before, after) {
  return Math.round((after / Math.max(before, 0.01) - 1) * 100);
}

/** Car-volume noise change. Not a measurement, and the tram's own sound is not in it. */
export function noiseDb(before, after) {
  return 10 * Math.log10(Math.max(after, 0.05) / Math.max(before, 0.05));
}

export function changeTrend(delta, tolerance) {
  if (delta < -tolerance) return "less";
  if (delta > tolerance) return "more";
  return "same";
}

export function airBand(no2) {
  if (no2 >= 20) return "air-high";
  if (no2 >= 15) return "air-mid";
  return "air-low";
}
