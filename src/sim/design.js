/**
 * Street layout and signal plan for each piece of the car route. A port of sim/design.py.
 *
 * Before is today's street: two-way, 90 second cycle, 50 seconds of green, no
 * coordination between junctions. After is the tram design the user sets:
 * width, direction, cycle, green, green wave, and whether trams get priority.
 */

export const PIECES = ["trunk", "bypass", "city", "fiera", "pilastro"];
export const LANE_M = 3.25;
export const TRACK_M = 6.5;
export const DEFAULT_WIDTH_M = 13;
export const WIDTH_M = { bypass: 20 };
export const SATURATION_PER_LANE = 1800;
export const TODAY_CYCLE_S = 90;
export const TODAY_GREEN_S = 50;
export const CROSS_MIN_S = 30;
export const TRAM_HOLD_S = 18;
export const MAX_GREEN_LOST = 0.65;
export const WAVE_MPS = 30 / 3.6;
export const WAVE_PROGRESSION = 0.7;
export const JUNCTION_M = 60;
export const MEASURE_S = 240;
export const COUNTER_SHARE = 0.75;
export const TODAY = { cycle: TODAY_CYCLE_S, green: TODAY_GREEN_S, carGreen: TODAY_GREEN_S, wave: false, tramWait: 0 };

/** Python's float modulo: the result takes the sign of the divisor. */
export function pyMod(value, divisor) {
  const rest = value % divisor;
  return rest !== 0 && (rest < 0) !== (divisor < 0) ? rest + divisor : rest;
}

/** Python's round(): halves go to the even neighbour. */
export function pyRound(value) {
  const floor = Math.floor(value);
  const diff = value - floor;
  if (diff > 0.5) return floor + 1;
  if (diff < 0.5) return floor;
  return floor % 2 === 0 ? floor : floor + 1;
}

export function defaultStreet(name) {
  return { width: WIDTH_M[name] ?? DEFAULT_WIDTH_M, oneWay: false, cycle: TODAY_CYCLE_S, green: TODAY_GREEN_S, wave: false };
}

export function defaultDesign() {
  return { priority: true, streets: Object.fromEntries(PIECES.map((name) => [name, defaultStreet(name)])) };
}

/** Fill missing keys from the default, so a partial design is valid. */
export function merge(design) {
  const base = defaultDesign();
  if (!design) return base;
  base.priority = design.priority === undefined ? true : Boolean(design.priority);
  for (const [name, street] of Object.entries(design.streets || {})) {
    if (!base.streets[name] || !street) continue;
    for (const [key, value] of Object.entries(street)) {
      if (value !== null && value !== undefined) base.streets[name][key] = value;
    }
  }
  return base;
}

/** Car lanes in the modelled direction, and whether the street runs one-way. */
export function streetLayout(piece, scenario, street) {
  const width = Number(street.width);
  if (scenario !== "after") {
    return { lanes: Math.max(1, Math.floor(width / (2 * LANE_M) + 1e-9)), oneWay: false, forced: false };
  }
  const room = width - (piece.affected ? TRACK_M : 0);
  const twoWay = Math.floor(room / (2 * LANE_M) + 1e-9);
  const oneWay = Boolean(street.oneWay) || twoWay < 1;
  const lanes = oneWay ? Math.floor(room / LANE_M + 1e-9) : twoWay;
  return { lanes: Math.max(1, lanes), oneWay, forced: oneWay && !street.oneWay };
}

export function tramPassages(headway) {
  return 2 * (60 / Math.max(headway, 0.5));
}

/** Cycle, green the cars actually get, and whether the lights run as a green wave. */
export function signalPlan(piece, scenario, street, priority, headway) {
  if (scenario !== "after") return { ...TODAY };
  const cycle = Number(street.cycle);
  const green = Math.min(Number(street.green), cycle - CROSS_MIN_S);
  let carGreen = green;
  let tramWait = 0;
  if (piece.affected) {
    if (priority) {
      const greenPerHour = (green / cycle) * 3600;
      const lost = Math.min(MAX_GREEN_LOST, (tramPassages(headway) * TRAM_HOLD_S) / Math.max(greenPerHour, 1));
      carGreen = green * (1 - lost);
    } else {
      const red = cycle - green;
      tramWait = (red * red) / (2 * cycle);
    }
  }
  return { cycle, green, carGreen, wave: Boolean(street.wave), tramWait };
}

/** Junction number of each signal. OSM puts a signal on each carriageway, so lights closer than 60 m are one junction. */
export function junctions(signals) {
  const groups = [];
  const first = [];
  for (const position of signals) {
    if (!first.length || position - first[first.length - 1] >= JUNCTION_M) first.push(position);
    groups.push(first.length - 1);
  }
  return { groups, first };
}

export function junctionCount(signals) {
  return junctions(signals).first.length;
}

/** Whole signal cycles covering at least four minutes, so a part-cycle never biases a count. */
export function measureWindow(cycle) {
  return cycle * Math.ceil(MEASURE_S / cycle - 1e-9);
}

/** Cars an hour the lights let through in the modelled direction. */
export function capacity(layout, plan) {
  return (layout.lanes * SATURATION_PER_LANE * plan.carGreen) / plan.cycle;
}

/** Seconds added to the clock at each signal. A green wave opens each light as a car at the limit arrives. */
export function offsets(signals, plan, model) {
  const cycle = plan.cycle;
  if (plan.wave) return signals.map((position) => pyMod(-position / WAVE_MPS, cycle));
  const { groups, first } = junctions(signals);
  if (model === "idm") return groups.map((group) => pyMod(first[group] * 0.1, cycle));
  return groups.map((group) => pyMod(group * 17, cycle));
}

export function layoutsAndPlans(corridor, scenario, design, headway) {
  const layouts = {};
  const plans = {};
  for (const [name, piece] of Object.entries(corridor.pieces)) {
    layouts[name] = streetLayout(piece, scenario, design.streets[name]);
    plans[name] = signalPlan(piece, scenario, design.streets[name], design.priority, headway);
  }
  return { layouts, plans };
}
