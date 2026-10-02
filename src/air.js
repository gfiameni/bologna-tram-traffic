import { tr } from "./i18n.js";

export function emissionLevel(sample, { scenario, cars, peakCars, carFlow, beforeCarFlow, activeLines }) {
  const hour = Math.max(0.12, cars / Math.max(peakCars || 1233, 1));
  const rank = sample.rank || 0.4;
  const flowRatio = Math.max(0, Math.min(1.5, carFlow / Math.max(beforeCarFlow, 1)));
  const active = activeLines || ["rossa"];
  const serving = scenario === "after" && active.length > 0;
  if (sample.line) return serving && active.includes(sample.line) ? 0.08 * hour : 0;
  if (sample.tram && serving && active.includes("rossa")) return 0.08 * hour * flowRatio;
  if (sample.tram && !serving) return Math.min(1, rank * hour);
  if (sample.ring) {
    const extra = serving ? 0.35 * flowRatio : 0;
    return Math.min(1, rank * hour * (0.8 + extra));
  }
  const inside = rank * hour * 0.55;
  return serving ? inside * flowRatio : inside;
}

export function airPaintValue(sample, view) {
  const active = view.activeLines || ["rossa"];
  const serving = view.scenario === "after" && active.length > 0;
  if (sample.line) {
    if (serving && active.includes(sample.line)) return { mode: "down", value: 0.7 };
    return { mode: "flat", value: 0 };
  }
  const level = emissionLevel(sample, view);
  if (!serving) return { mode: "level", value: level };
  const baseline = emissionLevel(sample, {
    ...view,
    scenario: "before",
    carFlow: view.beforeCarFlow,
    activeLines: [],
  });
  const delta = level - baseline;
  if (Math.abs(delta) < 0.03) return { mode: "flat", value: 0 };
  return { mode: delta > 0 ? "up" : "down", value: Math.min(1, Math.abs(delta) / 0.45) };
}

export function stationSummary(station, lang = "en") {
  const kind = station.kind ? `${tr(lang, `station.${station.kind}`)}. ` : "";
  return `${kind}NO2 ${station.no2} µg/m³, PM10 ${station.pm10} µg/m³.`;
}

function airColor(mode) {
  if (mode === "down") return [14, 116, 144];
  if (mode === "up") return [109, 40, 140];
  return [90, 70, 120];
}

export function createAir(map, canvas, centre, plan) {
  const ctx = canvas.getContext("2d");
  const samples = [
    ...(centre?.samples || []),
    ...(plan?.lines || []).filter((line) => line.id !== "rossa").flatMap((line) => line.samples || []),
  ];

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function dot(lat, lon, radius, color, alpha) {
    const point = map.latLngToContainerPoint([lat, lon]);
    if (point.x < -40 || point.y < -40 || point.x > canvas.clientWidth + 40 || point.y > canvas.clientHeight + 40) return;
    const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
    glow.addColorStop(0, `rgba(${color[0]},${color[1]},${color[2]},${alpha})`);
    glow.addColorStop(1, `rgba(${color[0]},${color[1]},${color[2]},0)`);
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
    ctx.fill();
  }

  function paint(view) {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    canvas.style.opacity = view.air ? "0.92" : "0";
    if (!view.air || !samples.length) return;
    const zoom = map.getZoom();
    const stride = zoom >= 15 ? 1 : zoom >= 14 ? 2 : 3;
    const radius = Math.max(11, Math.min(28, 11 * 2 ** (zoom - 14)));
    ctx.globalCompositeOperation = "lighter";
    for (let index = 0; index < samples.length; index += stride) {
      const painted = airPaintValue(samples[index], view);
      if (painted.value < 0.05) continue;
      const [red, green, blue] = airColor(painted.mode);
      dot(samples[index].lat, samples[index].lon, radius, [red, green, blue], 0.16 + 0.5 * painted.value);
    }
    ctx.globalCompositeOperation = "source-over";
    for (const station of view.stations || []) {
      dot(station.lat, station.lon, 18, [255, 250, 255], 0.95);
      dot(station.lat, station.lon, 8, [76, 29, 149], 1);
    }
  }

  resize();
  return { paint, resize };
}
