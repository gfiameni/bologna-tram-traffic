import { readFileSync } from "node:fs";
import {
  BUBBLE_KINDS,
  MIN_STRETCH_M,
  bubbleDiameter,
  changeTone,
  SPOT_LIMIT,
  pathMidpoint,
  pathPoints,
  placeBubbles,
  rankStretches,
  streetStretches,
  stretchValue,
} from "../src/bubbles.js";
import { loadRoads, runCity } from "../src/roads.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

const mid = pathMidpoint([[44.5, 11.3], [44.5, 11.32]]);
check("the midpoint of a straight road is halfway", Math.abs(mid[1] - 11.31) < 1e-9 && mid[0] === 44.5);

const step = 0.0063;
const segment = (id, name, kind, i, length = 500) => ({ id, name, kind, length, path: [[44.5, 11.3 + i * step], [44.5, 11.3 + (i + 1) * step]] });
const roads = [
  ...Array.from({ length: 10 }, (_, i) => segment(i, "Viale Lungo", "primary", i)),
  segment(10, "Via Corta", "secondary", 0, 200),
  segment(11, "Via Piccola", "tertiary", 3),
  segment(12, "", "primary", 5),
];
const city = { roads };
const stretches = streetStretches(city);
const long = stretches.filter((stretch) => stretch.name === "Viale Lungo");
check("a 5 km street is cut into stretches of about 2 km", long.length === 3);
check("every segment of the long street is in one stretch", long.flatMap((stretch) => stretch.ids).sort((a, b) => a - b).join() === "0,1,2,3,4,5,6,7,8,9");
const contiguous = long.every((stretch) => {
  const ids = [...stretch.ids].sort((a, b) => a - b);
  return ids.every((id, i) => !i || id === ids[i - 1] + 1);
});
check("a stretch is one run of the street", contiguous);
check("short, tertiary, and unnamed roads get no bubble", stretches.every((stretch) => stretch.name === "Viale Lungo"));
const onStreet = long.every((stretch) => stretch.ids.some((id) => {
  const [lat, lon] = pathMidpoint(roads[id].path);
  return lat === stretch.anchor.lat && lon === stretch.anchor.lon;
}));
check("each bubble sits on its own street", onStreet);

const dotted = pathPoints([[44.5, 11.3], [44.5, 11.3 + step]], 100);
check("a 500 m road gets a point every 100 m, from its start", dotted.length === 6 && dotted[0][1] === 11.3);
check("points along a road stay on it", dotted.every(([lat, lon]) => lat === 44.5 && lon >= 11.3 && lon <= 11.3 + step));
const sameSpot = (a, b) => a.lat === b.lat && a.lon === b.lon;
check("a bubble tries the middle of its stretch first", long.every((stretch) => sameSpot(stretch.spots[0], stretch.anchor)));
check("a stretch offers several spots", long.every((stretch) => stretch.spots.length > 5 && stretch.spots.length <= SPOT_LIMIT));
const span = (stretch) => {
  const ids = stretch.ids.map((id) => roads[id].path.flat().filter((_, i) => i % 2));
  return [Math.min(...ids.flat()), Math.max(...ids.flat())];
};
check("every spot lies on its stretch", long.every((stretch) => {
  const [west, east] = span(stretch);
  return stretch.spots.every((spot) => spot.lat === 44.5 && spot.lon >= west - 1e-9 && spot.lon <= east + 1e-9);
}));
check("spots move away from the middle", long.every((stretch) => {
  const far = stretch.spots.map((spot) => Math.abs(spot.lon - stretch.anchor.lon));
  return far.slice(1).every((value, i) => !i || value >= far[i] - 1e-12);
}));

const state = (id, worst, los, cars, extra = 0) => ({ id, worst, los, cars, open: [], extra });
const quiet = { roads: roads.map((road) => state(road.id, 0.4, "A", 500)) };
const busy = { roads: roads.map((road) => state(road.id, road.id < 2 ? 0.3 : 0.95, road.id < 2 ? "A" : "E", 1500)) };
const first = long.find((stretch) => stretch.ids.includes(0));
const value = stretchValue({ ids: [0, 2, 3] }, city, busy);
check("the typical load is the length-weighted median", value.load === 0.95 && value.level === "E");
check("the busiest point is the highest load", value.peak === 0.95 && value.peakLevel === "E");
check("cars are the length-weighted mean", Math.abs(value.cars - 1500) < 1e-9);

const after = { roads: quiet.roads.map((item) => (first.ids.includes(item.id) ? { ...item, worst: 0.8, los: "C", extra: 300 } : item)) };
const ranked = rankStretches(long, city, quiet, after);
check("a stretch the tram changes comes first", ranked[0].stretch === first && ranked[0].changed);
check("the ranking carries before and after values", ranked[0].before.load === 0.4 && ranked[0].after.load === 0.8);
check("an unchanged pair keeps the busiest first", rankStretches(long, city, busy).every((item, i, all) => !i || all[i - 1].carKm >= item.carKm));
const [, second, third] = long;
const mixed = {
  roads: quiet.roads.map((item) => {
    if (second.ids.includes(item.id)) return { ...item, open: ["rossa"], worst: 0.45 };
    if (third.ids.includes(item.id)) return { ...item, worst: 0.9, los: "E" };
    if (first.ids.includes(item.id)) return { ...item, worst: 0.5, los: "A" };
    return item;
  }),
};
const tiers = rankStretches(long, city, quiet, mixed);
check("a stretch the tram runs along comes first", tiers[0].stretch === second && tiers[0].tram);
check("then the largest change in load", tiers[1].stretch === third && tiers[2].stretch === first);

check("a fuller road draws a larger bubble", bubbleDiameter(1.1) > bubbleDiameter(0.6) && bubbleDiameter(0) === 30 && bubbleDiameter(5) === 46);
check("a large rise is the worst tone", changeTone(0.2) === "worse-much" && changeTone(0.05) === "worse" && changeTone(0.01) === "same");
check("a large fall is the best tone", changeTone(-0.2) === "better-much" && changeTone(-0.05) === "better");

const area = { left: 0, top: 0, right: 400, bottom: 300 };
const candidates = [
  { id: "first", x: 100, y: 100, d: 40 },
  { id: "overlap", x: 110, y: 105, d: 40 },
  { id: "edge", x: 395, y: 100, d: 40 },
  { id: "label", x: 200, y: 200, d: 40 },
  { id: "free", x: 300, y: 100, d: 40 },
];
const label = { x: 200, y: 200, w: 60, h: 30 };
const placed = placeBubbles(candidates, { area, taken: [label] }).map((bubble) => bubble.id);
check("overlapping bubbles keep the first", placed.includes("first") && !placed.includes("overlap"));
check("a bubble past the edge of the map is dropped", !placed.includes("edge"));
check("a bubble under a label is dropped", !placed.includes("label"));
check("a free bubble is kept", placed.includes("free"));
check("the limit caps the bubbles", placeBubbles(candidates, { limit: 1 }).length === 1);
const sliding = { id: "slide", d: 40, spots: [{ x: 200, y: 200 }, { x: 200, y: 140 }, { x: 200, y: 100 }] };
const slid = placeBubbles([sliding], { area, taken: [label] });
check("a bubble under a label slides along its street", slid.length === 1 && slid[0].x === 200 && slid[0].y === 140 && slid[0].spot === sliding.spots[1]);
const boxedIn = { id: "boxed", d: 40, spots: [{ x: 200, y: 200 }, { x: 395, y: 100 }] };
check("a bubble with no free spot stays off the map", placeBubbles([boxedIn], { area, taken: [label] }).length === 0);
const trail = { x: 100, y: 250, w: 40, h: 40, trail: true };
const queued = { x: 300, y: 250, w: 60, h: 70 };
const onTrail = placeBubbles([{ id: "street", d: 40, x: 100, y: 250, onTrail: true }], { area, taken: [trail, queued] });
check("a bubble of the queue's street takes the place of a trail marker", onTrail.length === 1 && onTrail[0].covers.length === 1 && onTrail[0].covers[0] === trail);
check("other bubbles keep clear of the trail", placeBubbles([{ id: "other", d: 40, x: 100, y: 250 }], { area, taken: [trail] }).length === 0);
check("the labelled queue bubble stays clear of every bubble", placeBubbles([{ id: "street", d: 40, x: 300, y: 250, onTrail: true }], { area, taken: [trail, queued] }).length === 0);

const bologna = loadRoads(JSON.parse(readFileSync(new URL("../public/roads.json", import.meta.url), "utf8")));
const real = streetStretches(bologna);
const names = new Set(real.map((stretch) => stretch.name));
check("Bologna has more than 100 bubble stretches", real.length > 100);
check("every stretch is long enough to describe", real.every((stretch) => stretch.length >= MIN_STRETCH_M));
check("every stretch is a trunk, primary, or secondary road", real.every((stretch) => BUBBLE_KINDS.includes(stretch.kind)));
check("every real stretch has spots to try", real.every((stretch) => stretch.spots.length >= 1 && stretch.spots.length <= SPOT_LIMIT));
check("the biggest roads all have bubbles", ["Viale Palmiro Togliatti", "Via Stalingrado", "Viale Sandro Pertini", "Via Emilia Ponente", "Via San Donato"].every((name) => names.has(name)));
const today = runCity(bologna, { scenario: "before", hour: 8 });
const withRossa = runCity(bologna, { scenario: "after", hour: 8, lines: ["rossa"], shift: 0.25, headway: 4.5 });
const order = rankStretches(real, bologna, today, withRossa);
const firstUnchanged = order.findIndex((item) => !item.changed);
check("with Rossa the changed stretches lead", firstUnchanged > 0 && order.slice(firstUnchanged).every((item) => !item.changed));
const firstOffLine = order.findIndex((item) => !item.tram);
check("with Rossa the streets it runs along lead", firstOffLine > 0 && order.slice(firstOffLine).every((item) => !item.tram));
check("Rossa runs along Via Aurelio Saffi and Via Emilia Ponente", ["Via Aurelio Saffi", "Via Emilia Ponente"].every((name) => order.some((item) => item.stretch.name === name && item.tram)));
check("Via Emilia Ponente fills up with Rossa", order.some((item) => item.stretch.name === "Via Emilia Ponente" && item.after.load > item.before.load + 0.1));
