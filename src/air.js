import { tr } from "./i18n.js";

/** A station's measured means in Before (2024) or After (2026). */
export function stationReading(station, scenario = "before") {
  return scenario === "after" && station.after ? station.after : station;
}

/** The reading as text; Compare gives both years, 2024 → 2026. */
export function readingText(station, gas, view = "before") {
  if (view !== "compare") return String(stationReading(station, view)[gas]);
  return `${stationReading(station, "before")[gas]} → ${stationReading(station, "after")[gas]}`;
}

export function stationSummary(station, lang = "en", view = "before") {
  const kind = station.kind ? `${tr(lang, `station.${station.kind}`)}. ` : "";
  return `${kind}NO2 ${readingText(station, "no2", view)} µg/m³, PM10 ${readingText(station, "pm10", view)} µg/m³.`;
}
