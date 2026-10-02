/** Peak-hour volume-delay model for the Linea Rossa corridor. */
import { count, tr } from "./i18n.js";

export const DEFAULTS = {
  carDemandPerHour: 2000,
  fieraShare: 0.56,
  modalShift: 0.25,
  carOccupancy: 1.3,
  transitDemandPerHour: 3400,
  busPerHour: 16,
  busCapacity: 95,
  tramCapacity: 220,
  tramHeadwayMin: 4.5,
  tramSpeedMps: 7.6,
  centerSpeedMps: 6.8,
  dwellSec: 26,
  freeSpeedMps: 12.5,
  capPerLane: 900,
  lanes: 2,
};

const ALPHA = 0.8;
const BETA = 2;
const SIGNAL_CYCLE_SEC = 90;
const SIGNAL_GREEN_SEC = 40;
const TRAM_HOLD_SEC = 18;
const CAR_LENGTH_M = {
  trunk: 5922,
  bypass: 2229,
  city: 1208,
  fiera: 1629,
  pilastro: 5618,
};
const TRAM_SIGNALS = { trunk: 21, bypass: 0, city: 6, fiera: 4, pilastro: 11 };

function websterDelay(greenSec) {
  const green = greenSec / SIGNAL_CYCLE_SEC;
  const volume = Math.min(0.92, green * 0.85);
  return 0.5 * SIGNAL_CYCLE_SEC * (1 - green) ** 2 / Math.max(0.08, 1 - volume);
}

/** Green left for cars when every tram gets the junction. */
export function carGreenSec(headwayMin) {
  const passagesPerHour = 2 * (60 / Math.max(headwayMin, 0.5));
  const greenPerHour = (SIGNAL_GREEN_SEC / SIGNAL_CYCLE_SEC) * 3600;
  const lost = Math.min(0.65, (passagesPerHour * TRAM_HOLD_SEC) / greenPerHour);
  return SIGNAL_GREEN_SEC * (1 - lost);
}

function priorityExtraSec(headwayMin) {
  return Math.max(0, websterDelay(carGreenSec(headwayMin)) - websterDelay(SIGNAL_GREEN_SEC));
}

/** Longer car trips where the tram runs. Bypass signals stay on the fixed cycle. */
export function applyTramPriority(result, headwayMin) {
  if (!result?.after || !(headwayMin > 0)) return result;
  const extra = priorityExtraSec(headwayMin);
  const after = {
    ...result.after,
    speeds: { ...result.after.speeds },
    carGreenSec: carGreenSec(headwayMin),
  };
  let fieraSec = 0;
  let pilastroSec = 0;
  for (const [name, signals] of Object.entries(TRAM_SIGNALS)) {
    if (!signals) continue;
    const added = signals * extra;
    const speed = after.speeds?.[name];
    const length = CAR_LENGTH_M[name];
    if (speed && length) after.speeds[name] = length / (length / speed + added);
    if (name === "trunk" || name === "city" || name === "fiera") fieraSec += added;
    if (name === "trunk" || name === "city" || name === "pilastro") pilastroSec += added;
  }
  after.carFieraMin += fieraSec / 60;
  after.carPilastroMin += pilastroSec / 60;
  if (after.speeds?.trunk) {
    after.viaEmiliaMps = after.speeds.trunk;
    after.viaEmiliaKmh = after.speeds.trunk * 3.6;
  }
  return { ...result, after };
}

export function volumeDelay(flowPerHour, capacityPerHour, freeMps) {
  const ratio = flowPerHour / Math.max(capacityPerHour, 1);
  return freeMps / (1 + ALPHA * ratio ** BETA);
}

function hav(a, b) {
  const r = 6371000;
  const p1 = (a[1] * Math.PI) / 180;
  const p2 = (b[1] * Math.PI) / 180;
  const dp = ((b[1] - a[1]) * Math.PI) / 180;
  const dl = ((b[0] - a[0]) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * r * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function polylineLength(coords) {
  let total = 0;
  for (let i = 1; i < coords.length; i++) total += hav(coords[i - 1], coords[i]);
  return total;
}

function project(coords, lon, lat) {
  let bestS = 0;
  let bestD = Infinity;
  let traveled = 0;
  for (let i = 1; i < coords.length; i++) {
    const a = coords[i - 1];
    const b = coords[i];
    const seg = hav(a, b) || 1e-6;
    const scale = Math.cos((a[1] * Math.PI) / 180);
    const vx = (b[0] - a[0]) * scale;
    const vy = b[1] - a[1];
    const wx = (lon - a[0]) * scale;
    const wy = lat - a[1];
    const den = vx * vx + vy * vy || 1e-12;
    const t = Math.max(0, Math.min(1, (wx * vx + wy * vy) / den));
    const proj = [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
    const dist = hav(proj, [lon, lat]);
    if (dist < bestD) {
      bestD = dist;
      bestS = traveled + seg * t;
    }
    traveled += seg;
  }
  return { s: bestS, dist: bestD };
}

function samplePolyline(coords) {
  const points = [];
  let traveled = 0;
  points.push({ lon: coords[0][0], lat: coords[0][1], s: 0 });
  for (let i = 1; i < coords.length; i++) {
    traveled += hav(coords[i - 1], coords[i]);
    points.push({ lon: coords[i][0], lat: coords[i][1], s: traveled });
  }
  return { points, length: traveled };
}

export function prepare(network) {
  const pieces = {};
  for (const mode of ["tram", "car"]) {
    pieces[mode] = {};
    for (const [name, coords] of Object.entries(network.pieces[mode])) {
      pieces[mode][name] = samplePolyline(coords);
    }
  }

  const stops = { trunk: [], fiera: [], pilastro: [] };
  for (const stop of network.stops) {
    const piece = stop.branch === "trunk" ? "trunk" : stop.branch;
    const hit = project(network.pieces.tram[piece], stop.lon, stop.lat);
    if (hit.dist < 90) stops[piece].push(hit.s);
  }
  for (const list of Object.values(stops)) list.sort((a, b) => a - b);

  const lengths = {
    tram: Object.fromEntries(Object.entries(pieces.tram).map(([k, v]) => [k, v.length])),
    car: Object.fromEntries(Object.entries(pieces.car).map(([k, v]) => [k, v.length])),
  };

  return {
    pieces,
    stops,
    lengths,
    affected: network.affected.car,
    screenS: network.screenline.tramTrunkM,
    screenName: network.screenline.name,
  };
}

function pieceSpeed(flow, affected, scenario, params) {
  const lanes = scenario === "after" && affected ? 1 : params.lanes;
  return volumeDelay(flow, lanes * params.capPerLane, params.freeSpeedMps);
}

function transitRide(geo, branch, runningMps, centerMps, params) {
  const { lengths, screenS } = geo;
  const west = Math.min(screenS, lengths.tram.trunk);
  const tail = Math.min(lengths.car.city, Math.max(0, lengths.tram.trunk - west));
  const center = Math.max(0, lengths.tram.trunk - west - tail);
  const spur = lengths.tram[branch];
  const seconds =
    west / runningMps.trunk +
    center / centerMps +
    tail / runningMps.city +
    spur / runningMps[branch];
  const intermediates =
    Math.max(0, geo.stops.trunk.length - 1) + Math.max(0, geo.stops[branch].length - 1);
  return (seconds + intermediates * params.dwellSec) / 60;
}

function carRide(geo, branch, speeds) {
  const { lengths } = geo;
  const meters = ["trunk", "bypass", "city", branch];
  const seconds = meters.reduce((sum, name) => sum + lengths.car[name] / speeds[name], 0);
  return seconds / 60;
}

export function evaluate(geo, params) {
  const out = {};
  for (const scenario of ["before", "after"]) {
    const shift = scenario === "after" ? params.modalShift : 0;
    const carFlow = params.carDemandPerHour * (1 - shift);
    const speeds = {};
    for (const name of Object.keys(geo.lengths.car)) {
      const flow = name === "fiera" || name === "pilastro" ? carFlow * (name === "fiera" ? params.fieraShare : 1 - params.fieraShare) : carFlow;
      speeds[name] = pieceSpeed(flow, geo.affected[name], scenario, params);
    }

    const shiftedPax = scenario === "after" ? params.carDemandPerHour * params.modalShift * params.carOccupancy : 0;
    const transitDemand = params.transitDemandPerHour + shiftedPax;
    const vehiclesPerHour = scenario === "after" ? 60 / params.tramHeadwayMin : params.busPerHour;
    const vehicleCapacity = scenario === "after" ? params.tramCapacity : params.busCapacity;
    const capacity = vehiclesPerHour * vehicleCapacity;
    const carried = Math.min(transitDemand, capacity);
    const tramMps = params.tramSpeedMps;
    const transitMin = scenario === "after"
      ? transitRide(geo, "fiera", { trunk: tramMps, city: tramMps, fiera: tramMps, pilastro: tramMps }, tramMps, params)
      : transitRide(geo, "fiera", speeds, params.centerSpeedMps, params);
    const transitPilastroMin = scenario === "after"
      ? transitRide(geo, "pilastro", { trunk: tramMps, city: tramMps, fiera: tramMps, pilastro: tramMps }, tramMps, params)
      : transitRide(geo, "pilastro", speeds, params.centerSpeedMps, params);

    out[scenario] = {
      carFieraMin: carRide(geo, "fiera", speeds),
      carPilastroMin: carRide(geo, "pilastro", speeds),
      transitFieraMin: transitMin,
      transitPilastroMin: transitPilastroMin,
      viaEmiliaMps: speeds.trunk,
      viaEmiliaKmh: speeds.trunk * 3.6,
      peoplePerHour: carFlow * params.carOccupancy + carried,
      transitLoad: carried / Math.max(capacity, 1),
      unserved: Math.max(0, transitDemand - capacity),
      carFlow,
      bikeFlow: 0,
      bikeSpeeds: Object.fromEntries(Object.keys(speeds).map((name) => [name, 5.2])),
      bikeFieraMin: (geo.lengths.car.trunk + geo.lengths.car.city + geo.lengths.car.fiera) / 5.2 / 60,
      speeds,
      transit: scenario === "after" ? "tram" : "bus",
      vehiclesPerHour,
    };
  }
  return applyTramPriority(out, params.tramHeadwayMin);
}

/** Rounded change in one car trip, with "slower", "faster", or "same". */
export function carChange(result, key = "carFieraMin") {
  const minutes = result.after[key] - result.before[key];
  const rounded = Math.round(minutes);
  const verdict = minutes >= 1 ? "slower" : minutes <= -1 ? "faster" : "same";
  return { minutes, rounded, verdict };
}

export function finding(result, { lang = "en", car = true } = {}) {
  const fiera = carChange(result, "carFieraMin");
  const agraria = carChange(result, "carPilastroMin");
  const peopleDelta = result.after.peoplePerHour - result.before.peoplePerHour;
  const carText = {
    slower: tr(lang, "finding.carSlower", { n: fiera.rounded }),
    faster: tr(lang, "finding.carFaster", { n: Math.abs(fiera.rounded) }),
    same: tr(lang, "finding.carSame"),
  }[fiera.verdict];
  const agrariaText = {
    slower: tr(lang, "finding.agrariaSlower", { n: agraria.rounded }),
    faster: tr(lang, "finding.agrariaFaster", { n: Math.abs(agraria.rounded) }),
    same: tr(lang, "finding.agrariaSame"),
  }[agraria.verdict];
  const peopleText = peopleDelta >= 0
    ? tr(lang, "finding.peopleMore", { n: count(lang, peopleDelta) })
    : tr(lang, "finding.peopleFewer", { n: count(lang, Math.abs(peopleDelta)) });
  const waiting = result.after.unserved > 80
    ? tr(lang, "finding.waiting", { n: count(lang, result.after.unserved) })
    : "";
  const flowDrop = (result.before.carFlow || 0) - (result.after.carFlow || 0);
  const flowText = flowDrop > 40
    ? tr(lang, "finding.flow", { n: count(lang, result.after.carFlow) })
    : "";
  return `${car ? `${carText}. ${agrariaText}. ` : ""}${peopleText}.${waiting}${flowText}`;
}
