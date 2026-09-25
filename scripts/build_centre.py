#!/usr/bin/env python3
"""Sample OpenStreetMap streets inside Bologna's historic centre.

The Comune publishes car counts on the ring boulevards, not on every street
inside the walls. This file stores the street geometry and a road-class rank.
The map then paints a heat overlay from those ranks and the hourly boulevard
demand. Output: public/centre.json.
"""

import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "centre-osm.json"
OUT = ROOT / "public" / "centre.json"
UA = "bologna-tram-traffic/1.0 (educational corridor model)"

# Inside the viali, from Porta San Felice to Porta Maggiore.
SOUTH, WEST, NORTH, EAST = 44.4894, 11.3284, 44.5078, 11.3586
BBOX = f"({SOUTH},{WEST},{NORTH},{EAST})"

RANK = {
    "trunk": 1.0,
    "primary": 0.92,
    "secondary": 0.68,
    "tertiary": 0.42,
    "unclassified": 0.28,
    "residential": 0.18,
    "living_street": 0.1,
}

TRAM_NAMES = {
    "via san felice",
    "piazza di porta san felice",
    "via riva di reno",
    "via ugo bassi",
    "via rizzoli",
    "via dell'indipendenza",
    "via dell’indipendenza",
}

RING_PREFIX = ("viale ", "piazza di porta")


def hav(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, h)))


def edge_m(lon, lat):
    dlat = min(abs(lat - SOUTH), abs(NORTH - lat)) * 111320
    dlon = min(abs(lon - WEST), abs(EAST - lon)) * 111320 * math.cos(math.radians(lat))
    return min(dlat, dlon)


HOSTS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
]


def fetch():
    if RAW.exists() and RAW.read_text()[:1] == "{":
        print("cached", RAW.name)
        return json.loads(RAW.read_text())
    query = (
        "[out:json][timeout:90];"
        f'(way["highway"~"^(trunk|primary|secondary|tertiary|unclassified|residential|living_street)$"]{BBOX};);'
        "out geom;"
    )
    RAW.parent.mkdir(parents=True, exist_ok=True)
    last_error = "overpass failed"
    for host in HOSTS:
        print("trying", host)
        try:
            subprocess.check_call([
                "curl", "-sS", "-L", "-A", UA, "--max-time", "180",
                host,
                "--data-urlencode", f"data={query}",
                "-o", str(RAW),
            ])
        except subprocess.CalledProcessError as error:
            last_error = str(error)
            continue
        text = RAW.read_text()
        if not text.strip().startswith("{"):
            last_error = text[-240:]
            continue
        data = json.loads(text)
        if "elements" in data:
            print("overpass elements", len(data["elements"]))
            return data
        last_error = str(data.get("remark") or data)
    raise SystemExit(last_error)


def samples_for(geom, step=48.0):
    coords = [(pt["lon"], pt["lat"]) for pt in geom if "lon" in pt]
    if len(coords) < 2:
        return []
    points = []
    leftover = 0.0
    total = 0.0
    for a, b in zip(coords, coords[1:]):
        span = hav(a, b)
        if span < 0.5:
            continue
        t = leftover
        while t <= span:
            u = t / span
            points.append((a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u))
            t += step
        leftover = t - span
        total += span
    if not points:
        points.append(coords[len(coords) // 2])
    return points, total


def classify(tags, lon, lat):
    name = (tags.get("name") or "").strip()
    key = name.casefold()
    highway = tags.get("highway") or "residential"
    tram = key in TRAM_NAMES
    ring = (not tram) and (
        key.startswith(RING_PREFIX) or (highway in {"trunk", "primary"} and edge_m(lon, lat) < 140)
    )
    return name, highway, tram, ring


def main():
    data = fetch()
    samples = []
    streets = 0
    for element in data.get("elements") or []:
        if element.get("type") != "way" or "geometry" not in element:
            continue
        tags = element.get("tags") or {}
        highway = tags.get("highway")
        if highway not in RANK:
            continue
        if tags.get("access") in {"private", "no"}:
            continue
        built = samples_for(element["geometry"])
        if not built:
            continue
        points, length = built
        if length < 40:
            continue
        streets += 1
        for lon, lat in points:
            name, kind, tram, ring = classify(tags, lon, lat)
            samples.append({
                "lat": round(lat, 6),
                "lon": round(lon, 6),
                "rank": RANK[kind],
                "ring": ring,
                "tram": tram,
            })
    hours = json.loads((ROOT / "data" / "hours.json").read_text())
    peak = max(slot["cars"] for slot in hours["slots"])
    payload = {
        "source": "OpenStreetMap highways inside the viali. ODbL.",
        "bbox": [SOUTH, WEST, NORTH, EAST],
        "peakCars": peak,
        "note": (
            "The Comune loop detectors sit on the boulevards. Heat on interior "
            "streets is a scenario: the selected model's car flow scales that "
            "boulevard hour across OSM road classes, not a count from every street."
        ),
        "samples": samples,
        "streets": streets,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print("streets", streets, "samples", len(samples), "bytes", OUT.stat().st_size)


if __name__ == "__main__":
    main()
