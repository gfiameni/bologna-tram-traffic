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
  if (sample.bypass) {
    const rossaOpen = serving && active.includes("rossa");
    return Math.min(1, rank * hour * (rossaOpen ? 1.2 + 0.25 * flowRatio : 1));
  }
  if (sample.line) {
    const busy = Math.min(1, (sample.rank || 0.7) * hour);
    if (serving && active.includes(sample.line)) return 0.22;
    return busy;
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

function mean(values) {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function placeCongestion(centre, plan, view) {
  const buckets = { centre: [], avenues: [], rossa: [], verde: [], gialla: [], blu: [] };
  for (const sample of centre?.samples || []) {
    const value = intensity(sample, view);
    if (sample.ring) buckets.avenues.push(value);
    else if (sample.tram) buckets.rossa.push(value);
    else buckets.centre.push(value);
  }
  for (const line of plan?.lines || []) {
    const bucket = buckets[line.id];
    if (!bucket) continue;
    for (const sample of line.samples || []) bucket.push(intensity(sample, view));
  }
  const places = Object.entries(buckets)
    .filter(([, values]) => values.length)
    .map(([id, values]) => ({ id, level: mean(values) }));
  places.push({ id: "bypass", level: intensity({ bypass: true, rank: 0.7 }, view) });
  places.sort((a, b) => b.level - a.level || a.id.localeCompare(b.id));
  return places;
}

function heatColor(value) {
  if (value > 0.72) return [154, 52, 18];
  if (value > 0.52) return [239, 108, 0];
  if (value > 0.36) return [224, 161, 0];
  return [31, 138, 76];
}

function changeColor(delta) {
  if (delta > 0.12) return [154, 52, 18];
  if (delta > 0.04) return [239, 108, 0];
  if (delta < -0.12) return [31, 138, 76];
  if (delta < -0.04) return [93, 206, 134];
  return [224, 161, 0];
}

export function createHeat(map, canvas, centre, plan, extra = []) {
  const ctx = canvas.getContext("2d");
  const samples = [
    ...(centre.samples || []),
    ...(plan?.lines || []).flatMap((line) => line.samples || []),
    ...extra,
  ];

  function resize() {
    const ratio = window.devicePixelRatio || 1;
    canvas.width = canvas.clientWidth * ratio;
    canvas.height = canvas.clientHeight * ratio;
    ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  }

  const pane = map.createPane("citytraffic");
  pane.style.zIndex = 250;
  pane.appendChild(canvas);
  canvas.classList.add("in-pane");

  function place() {
    const size = map.getSize();
    canvas.style.width = `${size.x}px`;
    canvas.style.height = `${size.y}px`;
    const topLeft = map.containerPointToLayerPoint([0, 0]);
    canvas.style.transform = `translate3d(${topLeft.x}px, ${topLeft.y}px, 0)`;
  }

  function paint(view) {
    place();
    resize();
    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);
    canvas.style.opacity = view.heatmap ? "0.9" : "0";
    if (!view.heatmap || !samples.length) return;
    const zoom = map.getZoom();
    const stride = zoom >= 14 ? 1 : 2;
    const radius = Math.max(16, Math.min(34, 18 * 2 ** (zoom - 13)));
    const size = canvas.clientWidth;
    const height = canvas.clientHeight;
    ctx.globalCompositeOperation = "lighter";
    for (let index = 0; index < samples.length; index += 1) {
      const sample = samples[index];
      if (!sample.line && !sample.bypass && stride > 1 && index % stride) continue;
      const point = map.latLngToContainerPoint([sample.lat, sample.lon]);
      if (point.x < -40 || point.y < -40 || point.x > size + 40 || point.y > height + 40) continue;
      const beforeLevel = intensity(sample, { ...view, scenario: "before", carFlow: view.beforeCarFlow });
      const afterLevel = intensity(sample, { ...view, scenario: "after", carFlow: view.afterCarFlow ?? view.carFlow });
      const value = view.mode === "compare" ? Math.abs(afterLevel - beforeLevel) : intensity(sample, view);
      if (value < 0.05) continue;
      const [red, green, blue] = view.mode === "compare" ? changeColor(afterLevel - beforeLevel) : heatColor(value);
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
