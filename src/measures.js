/**
 * Push overlapping label boxes apart. Boxes are centred on x, y. Fixed boxes do not move.
 * With an area ({ left, top, right, bottom }), every box also stays inside it.
 */
export function spreadBoxes(boxes, fixed = [], { iterations = 60, pad = 6, area = null } = {}) {
  const keepInside = (box) => {
    if (!area) return false;
    const x = Math.max(area.left + box.w / 2, Math.min(area.right - box.w / 2, box.x));
    const y = Math.max(area.top + box.h / 2, Math.min(area.bottom - box.h / 2, box.y));
    const moved = x !== box.x || y !== box.y;
    box.x = x;
    box.y = y;
    return moved;
  };
  for (const box of boxes) keepInside(box);
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
    for (const box of boxes) keepInside(box);
    if (!moved) break;
  }
  return boxes;
}

/**
 * Where a tooltip opens around a point of radius r: above it, or toward the map when it would
 * run past the edge of the area ({ left, top, right, bottom }) and under a panel.
 */
export function tipSide({ x, y }, area, r = 0, { width = 290, height = 110 } = {}) {
  if (area && x - width / 2 < area.left) return { direction: "right", offset: [r, 0] };
  if (area && x + width / 2 > area.right) return { direction: "left", offset: [-r, 0] };
  if (area && y - r - height < area.top) return { direction: "bottom", offset: [0, r] };
  return { direction: "top", offset: [0, -r] };
}

export function measureDiameter(value, scale, min = 30, span = 34) {
  const ratio = Math.max(0, Math.min(1, value / Math.max(scale, 1)));
  return Math.round(min + span * Math.sqrt(ratio));
}

export function airBand(no2) {
  if (no2 >= 20) return "air-high";
  if (no2 >= 15) return "air-mid";
  return "air-low";
}
