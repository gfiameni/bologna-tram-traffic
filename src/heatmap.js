export function hourCars(catalog, hour, fallback = 1155) {
  const slot = catalog?.hours?.find((item) => item.hour === hour);
  return slot?.cars ?? fallback;
}

export function intensity(sample, { scenario, cars, peakCars, carFlow, beforeCarFlow, activeLines }) {
  const hour = Math.max(0.12, cars / Math.max(peakCars || 1233, 1));
  const rank = sample.rank;
  const flowRatio = Math.max(0, Math.min(1.5, carFlow / Math.max(beforeCarFlow, 1)));
  const active = activeLines || ["rossa"];
  const serving = scenario === "after" && active.length > 0;
  if (sample.line) {
    if (serving && active.includes(sample.line)) return 0.22;
    return 0;
  }
  if (sample.tram && serving && active.includes("rossa")) return Math.min(1, 0.08 * hour * flowRatio);
  if (sample.tram && !serving) return Math.min(1, rank * hour);
  if (sample.ring) {
    const extra = serving ? 0.3 * flowRatio : 0;
    return Math.min(1, rank * hour * (0.82 + extra));
  }
  const inside = rank * hour * 0.62;
  return serving ? inside * flowRatio : inside;
}

function heatColor(value) {
  if (value > 0.72) return [154, 52, 18];
  if (value > 0.52) return [239, 108, 0];
  if (value > 0.36) return [224, 161, 0];
  return [31, 138, 76];
}

export function createHeat(map, canvas, centre, plan) {
  const ctx = canvas.getContext("2d");
  const samples = [
    ...(centre.samples || []),
    ...(plan?.lines || []).filter((line) => line.id !== "rossa").flatMap((line) => line.samples || []),
  ];

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  function paint(view) {
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    canvas.style.opacity = view.heatmap ? "0.9" : "0";
    if (!view.heatmap || !samples.length) return;
    const zoom = map.getZoom();
    const stride = zoom >= 15 ? 1 : zoom >= 14 ? 2 : 3;
    const radius = Math.max(11, Math.min(30, 12 * 2 ** (zoom - 14)));
    const size = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.globalCompositeOperation = "lighter";
    for (let index = 0; index < samples.length; index += stride) {
      const sample = samples[index];
      const point = map.latLngToContainerPoint([sample.lat, sample.lon]);
      if (point.x < -40 || point.y < -40 || point.x > size + 40 || point.y > height + 40) continue;
      const value = intensity(sample, view);
      if (value < 0.05) continue;
      const [red, green, blue] = heatColor(value);
      const glow = ctx.createRadialGradient(point.x, point.y, 0, point.x, point.y, radius);
      glow.addColorStop(0, `rgba(${red},${green},${blue},${0.18 + 0.55 * value})`);
      glow.addColorStop(1, `rgba(${red},${green},${blue},0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(point.x, point.y, radius, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = "source-over";
  }

  function showCentre() {
    const box = centre.bbox;
    if (!box) return;
    map.fitBounds(
      [
        [box[0], box[1]],
        [box[2], box[3]],
      ],
      {
        paddingTopLeft: [window.innerWidth > 800 ? 430 : 24, 24],
        paddingBottomRight: [24, 70],
        maxZoom: 15,
      },
    );
  }

  resize();
  return { paint, resize, showCentre, note: centre.note, bbox: centre.bbox };
}
