/** Run one of the four corridor models in the browser. Python in sim/ is the reference. */
import * as bpr from "./bpr.js";
import * as ctm from "./ctm.js";
import * as idm from "./idm.js";
import * as surrogate from "./surrogate.js";
import { merge } from "./design.js";
import { forYear } from "./engine.js";

export const MODELS = { bpr, ctm, idm, surrogate };

/** `year` picks the measured demand ("before" 2024, "after" 2026); it follows the scenario by default. */
export function runModel(name, corridor, scenario, shift, headway, { hour = 8, design = null, year = null } = {}) {
  const model = MODELS[name];
  if (!model) throw new Error(`unknown model ${name}`);
  return model.run(forYear(corridor, year ?? scenario), scenario, shift, headway, hour, merge(design));
}

/** Before and after for one setup. */
export function runPair(name, corridor, { shift, headway, hour, design }) {
  return {
    before: runModel(name, corridor, "before", shift, headway, { hour, design }),
    after: runModel(name, corridor, "after", shift, headway, { hour, design }),
  };
}

export { loadCorridor, hourRow, forYear } from "./engine.js";
export * from "./design.js";
