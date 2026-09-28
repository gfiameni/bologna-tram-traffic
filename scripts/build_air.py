#!/usr/bin/env python3
"""Write public/air.json from Comune di Bologna station means and official UTM positions.

The means are hourly NO2 and PM10 from centraline-qualita-aria. Coordinates are the
2019 regional classification (Bollettino ufficiale), UTM zone 32N, converted to WGS84.
The file does not contain a dispersion field.
"""

import json
import math
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "air.json"
API = "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/centraline-qualita-aria/records"

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


def means(agent):
    query = urllib.parse.urlencode({
        "select": "stazione, avg(value) as mean",
        "where": f'agente_atm = "{agent}"',
        "group_by": "stazione",
        "limit": 10,
    })
    with urllib.request.urlopen(API + "?" + query) as response:
        payload = json.load(response)
    return {row["stazione"]: row["mean"] for row in payload["results"]}


def main():
    no2 = means("NO2 (Biossido di azoto)")
    pm10 = means("PM10")
    stations = []
    for station in STATIONS:
        lat, lon = utm_to_wgs84(*station["utm"])
        no2_row = next(value for name, value in no2.items() if station["match"] in name)
        pm10_row = next(value for name, value in pm10.items() if station["match"] in name)
        stations.append({
            "id": station["id"],
            "name": station["name"],
            "kind": station["kind"],
            "lat": lat,
            "lon": lon,
            "no2": round(no2_row),
            "pm10": round(pm10_row),
        })
    payload = {
        "source": "https://opendata.comune.bologna.it/explore/dataset/centraline-qualita-aria/",
        "licence": "CC BY 4.0",
        "publisher": "Comune di Bologna, measurements from ARPAE Emilia-Romagna",
        "period": "1 January–16 September 2026",
        "unit": "µg/m³",
        "note": (
            "Hourly means at the three Bologna stations. Coordinates come from the 2019 regional "
            "station list, UTM zone 32N. The tram is not in passenger service, so these readings "
            "do not show a tram before and after. The street colour is a kerb exhaust proxy from "
            "the traffic model. It is not a plume and not a concentration forecast."
        ),
        "stations": stations,
    }
    OUT.write_text(json.dumps(payload, indent=2) + "\n")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
