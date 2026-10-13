/** Heat along the main roads for one measure, drawn on a canvas inside the map. */

export const HEAT_MEASURES = ["traffic", "congestion", "air", "noise"];

function clamp(value) {
  return Math.max(0, Math.min(1, value));
}

const FIXED_SCALE = {
  traffic: { lo: 0, hi: 1000 },
  congestion: { lo: 0.3, hi: 1.1 },
  air: { lo: 0, hi: 2500 },
  noise: { lo: 0, hi: 3000 },
};

/** Cars per lane, load, exhaust per km, or traffic sound energy in car equivalents. */
export function rawValue(measure, road, state) {
  if (!state) return 0;
  if (measure === "traffic") return state.cars / Math.max(1, road.lanes[0] + road.lanes[1]);
  if (measure === "congestion") return state.worst;
  if (measure === "air") return state.exhaust / Math.max(0.01, road.length / 1000);
  if (measure === "noise") return state.noise;
  return 0;
}

function quantile(sorted, q) {
  return sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))];
}

/** The range of one measure across the Before roads, so the glow uses the city's own spread. */
export function heatScale(measure, city, result) {
  if (measure === "congestion") return FIXED_SCALE.congestion;
  const values = result.roads
    .map((state) => rawValue(measure, city.roads[state.id], state))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  if (values.length < 10) return FIXED_SCALE[measure];
  return { lo: 0, hi: quantile(values, 0.95) };
}

/** How strong one measure is on one road, from 0 to 1. */
export function measureValue(measure, road, state, scale = FIXED_SCALE[measure]) {
  if (!state || !scale) return 0;
  return clamp((rawValue(measure, road, state) - scale.lo) / Math.max(1e-9, scale.hi - scale.lo));
}

export function heatColor(value) {
  if (value > 0.75) return [154, 52, 18];
  if (value > 0.55) return [239, 108, 0];
  if (value > 0.35) return [224, 161, 0];
  return [31, 138, 76];
}

export function changeColor(delta) {
  if (delta > 0.12) return [190, 40, 30];
  if (delta > 0) return [239, 108, 0];
  if (delta < -0.12) return [31, 138, 76];
  return [110, 200, 120];
}

export function createRoadHeat(map, canvas) {
  const ctx = canvas.getContext("2d");
  const pane = map.createPane("roadheat");
  pane.style.zIndex = 390;
  pane.style.pointerEvents = "none";
  pane.appendChild(canvas);
  canvas.classList.add("in-pane");

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    const size = map.getSize();
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    canvas.width = size.x * ratio;
    canvas.height = size.y * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    canvas.style.transform = `translate3d(${topLeft.x}px, ${topLeft.y}px, 0)`;
  }

  function paint({ visible, city, measure, mode, before, after }) {
    resize();
    const size = map.getSize();
    ctx.clearRect(0, 0, size.x, size.y);
    canvas.style.opacity = visible ? "1" : "0";
    if (!visible || !measure || !city) return;
    const zoom = map.getZoom();
    const width = Math.max(6, Math.min(26, 9 * 2 ** (zoom - 13)));
    const view = map.getBounds().pad(0.15);
    const scale = heatScale(measure, city, before);
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    for (const road of city.roads) {
      if (!view.intersects(road.bounds)) continue;
      const was = measureValue(measure, road, before.roads[road.id], scale);
      const now = measureValue(measure, road, after.roads[road.id], scale);
      let color;
      let alpha;
      if (mode === "compare") {
        const delta = now - was;
        if (Math.abs(delta) < 0.03) continue;
        color = changeColor(delta);
        alpha = Math.min(0.95, 0.5 + 2 * Math.abs(delta));
      } else {
        const value = mode === "after" ? now : was;
        if (value < 0.12) continue;
        color = heatColor(value);
        alpha = 0.25 + 0.7 * value;
      }
      ctx.strokeStyle = `rgba(${color[0]},${color[1]},${color[2]},${alpha})`;
      ctx.lineWidth = road.kind === "tertiary" ? width * 0.7 : width;
      ctx.beginPath();
      road.path.forEach(([lat, lon], index) => {
        const point = map.latLngToContainerPoint([lat, lon]);
        if (index) ctx.lineTo(point.x, point.y);
        else ctx.moveTo(point.x, point.y);
      });
      ctx.stroke();
    }
  }

  return { paint, resize };
}
