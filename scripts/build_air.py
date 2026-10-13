#!/usr/bin/env python3
"""Write public/air.json from the Comune's station means for 2024 and 2026, and official UTM positions.

The means are hourly NO2 and PM10: 2024 from dati-centraline-bologna-storico for Before,
2026 from centraline-qualita-aria for After. Both years cover 1 January to the last day the
2026 dataset holds, so the seasons match. Coordinates are the 2019 regional classification
(Bollettino ufficiale), UTM zone 32N, converted to WGS84. The file does not contain a
dispersion field.
"""

import json
import math
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "air.json"
DATASETS = "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/"
PAGES = "https://opendata.comune.bologna.it/explore/dataset/"
HISTORY = "dati-centraline-bologna-storico"
CURRENT = "centraline-qualita-aria"
BEFORE_YEAR = 2024
AFTER_YEAR = 2026

# Easting, northing from the 2019 Emilia-Romagna station classification.
STATIONS = [
    {
        "id": "porta-san-felice",
        "name": "Porta San Felice",
        "kind": "Urban traffic",
        "match": "PORTA SAN FELICE",
        "utm": (685120, 4930139),
    },
    {
        "id": "giardini-margherita",
        "name": "Giardini Margherita",
        "kind": "Urban background",
        "match": "GIARDINI MARGHERITA",
        "utm": (687282, 4928379),
    },
    {
        "id": "via-chiarini",
        "name": "Via Chiarini",
        "kind": "Suburban background",
        "match": "VIA CHIARINI",
        "utm": (681708, 4929859),
    },
]


def utm_to_wgs84(easting, northing, zone=32):
    a = 6378137.0
    f = 1 / 298.257223563
    k0 = 0.9996
    e2 = f * (2 - f)
    ep2 = e2 / (1 - e2)
    x = easting - 500000.0
    y = northing
    lon0 = math.radians((zone - 1) * 6 - 180 + 3)
    meridional = y / k0
    mu = meridional / (a * (1 - e2 / 4 - 3 * e2 * e2 / 64 - 5 * e2 ** 3 / 256))
    e1 = (1 - math.sqrt(1 - e2)) / (1 + math.sqrt(1 - e2))
    phi1 = (
        mu
        + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * math.sin(2 * mu)
        + (21 * e1 ** 2 / 16 - 55 * e1 ** 4 / 32) * math.sin(4 * mu)
        + (151 * e1 ** 3 / 96) * math.sin(6 * mu)
    )
    n1 = a / math.sqrt(1 - e2 * math.sin(phi1) ** 2)
    t1 = math.tan(phi1) ** 2
    c1 = ep2 * math.cos(phi1) ** 2
    r1 = a * (1 - e2) / (1 - e2 * math.sin(phi1) ** 2) ** 1.5
    d = x / (n1 * k0)
    lat = phi1 - (n1 * math.tan(phi1) / r1) * (
        d * d / 2
        - (5 + 3 * t1 + 10 * c1 - 4 * c1 * c1 - 9 * ep2) * d ** 4 / 24
        + (61 + 90 * t1 + 298 * c1 + 45 * t1 * t1 - 252 * ep2 - 3 * c1 * c1) * d ** 6 / 720
    )
    lon = lon0 + (
        d
        - (1 + 2 * t1 + c1) * d ** 3 / 6
        + (5 - 2 * c1 + 28 * t1 - 3 * c1 * c1 + 8 * ep2 + 24 * t1 * t1) * d ** 5 / 120
    ) / math.cos(phi1)
    return round(math.degrees(lat), 6), round(math.degrees(lon), 6)


def records(dataset, **params):
    with urllib.request.urlopen(DATASETS + dataset + "/records?" + urllib.parse.urlencode(params)) as response:
        return json.load(response)["results"]


def last_day():
    """The last full day the current-year dataset holds."""
    rows = records(CURRENT, select="max(reftime) as last", where=f"reftime >= date'{AFTER_YEAR}-01-01'", limit=1)
    last = datetime.fromisoformat(rows[0]["last"]).date()
    return last if last.year == AFTER_YEAR else date(AFTER_YEAR, 12, 31)


def window(year, end):
    """1 January to the end day, as an ODSQL range on `field`."""
    stop = date(year, end.month, end.day) + timedelta(days=1)
    return lambda field: f"{field} >= date'{year}-01-01' AND {field} < date'{stop.isoformat()}'"


def means_before(agent, end):
    rows = records(HISTORY, select="cod_staz, avg(valore) as mean", group_by="cod_staz", limit=10,
                   where=f'{window(BEFORE_YEAR, end)("data_inizio")} AND agente = "{agent}"')
    return {row["cod_staz"]: row["mean"] for row in rows}


def means_after(agent, end):
    rows = records(CURRENT, select="stazione, avg(value) as mean", group_by="stazione", limit=10,
                   where=f'{window(AFTER_YEAR, end)("reftime")} AND agente_atm = "{agent}"')
    return {row["stazione"]: row["mean"] for row in rows}


def pick(means, station):
    return round(next(value for name, value in means.items() if station["match"] in name.upper()))


def period(year, end):
    return f"1 January–{end.day} {end.strftime('%B')} {year}"


def notes(end):
    """One note for each view, so Before reads only 2024."""
    common = ("Coordinates come from the 2019 regional station list, UTM zone 32N. The street colour is a kerb "
              "exhaust proxy from the traffic model. It is not a plume and not a concentration forecast.")
    span = f"1 January–{end.day} {end.strftime('%B')}"
    return {
        "before": f"Hourly means at the three Bologna stations, {period(BEFORE_YEAR, end)}. {common}",
        "after": (f"Hourly means at the three Bologna stations, {period(AFTER_YEAR, end)}. The tram is not in "
                  f"passenger service in {AFTER_YEAR}, so these readings do not include it. {common}"),
        "compare": (f"Hourly means at the three Bologna stations, {span} of {BEFORE_YEAR} and of {AFTER_YEAR}, so the "
                    f"seasons match. The tram is not in passenger service in {AFTER_YEAR}, so the change between the "
                    f"two years is not a tram effect. {common}"),
    }


def main():
    end = last_day()
    before = {"no2": means_before("NO2 (BIOSSIDO DI AZOTO)", end), "pm10": means_before("PM10", end)}
    after = {"no2": means_after("NO2 (Biossido di azoto)", end), "pm10": means_after("PM10", end)}
    stations = []
    for station in STATIONS:
        lat, lon = utm_to_wgs84(*station["utm"])
        stations.append({
            "id": station["id"],
            "name": station["name"],
            "kind": station["kind"],
            "lat": lat,
            "lon": lon,
            "no2": pick(before["no2"], station),
            "pm10": pick(before["pm10"], station),
            "after": {"no2": pick(after["no2"], station), "pm10": pick(after["pm10"], station)},
        })
    payload = {
        "source": PAGES + HISTORY + "/",
        "sourceAfter": PAGES + CURRENT + "/",
        "licence": "CC BY 4.0",
        "publisher": "Comune di Bologna, measurements from ARPAE Emilia-Romagna",
        "years": {"before": BEFORE_YEAR, "after": AFTER_YEAR},
        "periods": {"before": period(BEFORE_YEAR, end), "after": period(AFTER_YEAR, end)},
        "through": end.strftime("%m-%d"),
        "unit": "µg/m³",
        "notes": notes(end),
        "stations": stations,
    }
    payload["note"] = payload["notes"]["compare"]
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
