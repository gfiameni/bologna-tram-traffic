import { tr } from "./i18n.js";

export function stationSummary(station, lang = "en") {
  const kind = station.kind ? `${tr(lang, `station.${station.kind}`)}. ` : "";
  return `${kind}NO2 ${station.no2} µg/m³, PM10 ${station.pm10} µg/m³.`;
}
