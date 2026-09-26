#!/usr/bin/env python3
"""Build the four planned Bologna tram lines from named OpenStreetMap streets.

The street lists follow the corridors published on https://www.trambologna.it/progetto/
and the PUMS technical note for the same four lines. Output: public/lines.json.
"""

import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "planned-lines-osm.json"
OUT = ROOT / "public" / "lines.json"
UA = "bologna-tram-traffic/1.0 (educational corridor model)"
BBOX = "(44.45,11.22,44.56,11.48)"
HOSTS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
]

LINES = [
    {
        "id": "rossa",
        "name": "Rossa",
        "termini": "Emilio Lepido – Michelino / Agraria",
        "color": "#e30613",
        "source": "network",
    },
    {
        "id": "verde",
        "name": "Verde",
        "termini": "Via dei Mille – Corticella",
        "color": "#1f8a4c",
        "seed": (11.342, 44.494),
        "streets": [
            ["Via dei Mille"],
            ["Via dell'Indipendenza"],
            ["Via Giacomo Matteotti"],
            ["Via Ferrarese"],
            ["Piazza dell'Unità"],
            ["Via di Corticella"],
            ["Via Genuzio Bentini", "Via Bentini"],
            ["Via Sant'Anna"],
            ["Via Georges Gordon Byron", "Via Giorgio Byron", "Via Byron"],
            ["Via William Shakespeare", "Via Shakespeare"],
        ],
    },
    {
        "id": "gialla",
        "name": "Gialla",
        "termini": "Casteldebole – Rastignano",
        "color": "#c48a00",
        "seed": (11.29, 44.495),
        "streets": [
            ["Viale Gaetano Salvemini", "Via Gaetano Salvemini", "Via Salvemini"],
            ["Viale Palmiro Togliatti", "Via Togliatti"],
            ["Via Mahatma Gandhi", "Via Gandhi"],
            ["Via Marzabotto"],
            ["Via Emilia Ponente"],
            ["Via Aurelio Saffi"],
            ["Via San Felice"],
            ["Via Ugo Bassi"],
            ["Via Luigi Carlo Farini", "Via Farini"],
            ["Via Santo Stefano"],
            ["Via Augusto Murri", "Via Murri"],
            ["Via Toscana"],
        ],
    },
    {
        "id": "blu",
        "name": "Blu",
        "color": "#1e4f86",
        "termini": "Casalecchio – San Lazzaro",
        "seed": (11.27, 44.48),
        "streets": [
            ["Via Don Luigi Sturzo", "Via Don Sturzo"],
            ["Via Andrea Costa"],
            ["Via Sant'Isaia"],
            ["Piazza Malpighi", "Via Marcello Malpighi", "Via Malpighi"],
            ["Via Guglielmo Marconi"],
            ["Via Ugo Bassi"],
            ["Via Rizzoli"],
            ["Strada Maggiore"],
            ["Via Giuseppe Mazzini", "Via Mazzini"],
            ["Via Emilia Levante"],
            ["Via Caselle"],
        ],
    },
]


def hav(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    radius = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(math.sqrt(min(1.0, h)))


def fetch():
    if RAW.exists() and RAW.read_text()[:1] == "{":
        print("cached", RAW.name)
        return json.loads(RAW.read_text())["elements"]
    names = sorted({alias for line in LINES for group in line.get("streets", []) for alias in group})
    clauses = "\n".join(f'  way["name"="{name}"]{BBOX};' for name in names)
    query = f"[out:json][timeout:90];\n(\n{clauses}\n);\nout geom;"
    RAW.parent.mkdir(parents=True, exist_ok=True)
    last = "overpass failed"
    for host in HOSTS:
        print("trying", host)
        try:
            subprocess.check_call([
                "curl", "-sS", "-L", "-A", UA, "--max-time", "180", host,
                "--data-urlencode", f"data={query}", "-o", str(RAW),
            ])
        except subprocess.CalledProcessError as error:
            last = str(error)
            continue
        text = RAW.read_text()
        if text[:1] != "{":
            last = text[-180:]
            continue
        data = json.loads(text)
        if "elements" in data:
            print("elements", len(data["elements"]))
            return data["elements"]
        last = str(data.get("remark") or data)
    raise SystemExit(last)


def chains_for(elements, names):
    ways = []
    for element in elements:
        tags = element.get("tags") or {}
        if tags.get("name") not in names:
            continue
        geom = [(point["lon"], point["lat"]) for point in element.get("geometry") or []]
        if len(geom) >= 2:
            ways.append(geom)
    unused = set(range(len(ways)))
    chains = []
    while unused:
        index = unused.pop()
        chain = ways[index][:]
        grew = True
        while grew:
            grew = False
            for other in list(unused):
                geom = ways[other]
                pairs = (
                    (chain[-1], geom[0], geom),
                    (chain[-1], geom[-1], list(reversed(geom))),
                    (chain[0], geom[-1], geom),
                    (chain[0], geom[0], list(reversed(geom))),
                )
                for end, start, ordered in pairs:
                    if hav(end, start) < 35:
                        if end == chain[0]:
                            chain = ordered[:-1] + chain
                        else:
                            chain = chain + ordered[1:]
                        unused.remove(other)
                        grew = True
                        break
                if grew:
                    break
        chains.append(chain)
    return chains


def length(chain):
    return sum(hav(a, b) for a, b in zip(chain, chain[1:]))


def orient(chain, target):
    if target is None:
        return chain
    if hav(chain[0], target) <= hav(chain[-1], target):
        return chain
    return list(reversed(chain))


def mid(chain):
    return chain[len(chain) // 2]


def trace(elements, groups, seed):
    segments = []
    cursor = seed
    for aliases in groups:
        options = chains_for(elements, set(aliases))
        if not options:
            print("missing", aliases[0])
            continue
        near = [item for item in options if 11.25 <= mid(item)[0] <= 11.43 and 44.45 <= mid(item)[1] <= 44.555]
        options = near or options
        chain = min(options, key=lambda item: min(hav(item[0], cursor), hav(item[-1], cursor)))
        if not (11.25 <= mid(chain)[0] <= 11.43 and 44.45 <= mid(chain)[1] <= 44.555):
            print("skip outside", aliases[0])
            continue
        gap = min(hav(chain[0], cursor), hav(chain[-1], cursor))
        if gap > 6000:
            print("skip far", aliases[0], round(gap))
            continue
        chain = orient(chain, cursor)
        if segments and hav(cursor, chain[0]) < 100:
            segments[-1].extend(chain[1:])
        else:
            segments.append(chain[:])
        cursor = chain[-1]
    return segments


def samples(points, step=80.0):
    if len(points) < 2:
        return []
    out = [points[0]]
    carry = 0.0
    for start, end in zip(points, points[1:]):
        span = hav(start, end)
        if span < 1:
            continue
        cursor = step - carry
        while cursor <= span:
            t = cursor / span
            out.append((start[0] + (end[0] - start[0]) * t, start[1] + (end[1] - start[1]) * t))
            cursor += step
        carry = span - (cursor - step)
    return out


def rossa_points():
    network = json.loads((ROOT / "public" / "network.json").read_text())
    pieces = network["pieces"]["tram"]
    segments = []
    for name in ("trunk", "fiera", "pilastro"):
        segment = []
        for lon, lat in pieces[name]:
            if not segment or hav(segment[-1], (lon, lat)) > 15:
                segment.append((lon, lat))
        segments.append(segment)
    return segments


def pack(line, segments):
    kept = [[[round(lat, 6), round(lon, 6)] for lon, lat in segment] for segment in segments]
    heat = []
    for segment in segments:
        for lon, lat in samples(segment):
            heat.append({"lat": round(lat, 6), "lon": round(lon, 6), "line": line["id"], "rank": 0.7})
    return {
        "id": line["id"],
        "name": line["name"],
        "termini": line["termini"],
        "color": line["color"],
        "segments": kept,
        "samples": heat,
    }


def main():
    elements = fetch()
    lines = []
    for line in LINES:
        points = rossa_points() if line["id"] == "rossa" else trace(elements, line["streets"], line["seed"])
        packed = pack(line, points)
        print(line["id"], "segments", len(packed["segments"]), "samples", len(packed["samples"]))
        lines.append(packed)
    payload = {
        "source": "https://www.trambologna.it/progetto/",
        "note": (
            "Four lines from the Tram Bologna network page. Rossa is the corridor already modelled. "
            "Verde follows the published Via dei Mille–Corticella streets. Gialla and Blu follow the "
            "PUMS corridors named on that page. Each extra open line is a scenario: it takes a share "
            "of cars off the street and cools the heatmap. It is not a second full assignment model."
        ),
        "extraShift": {"verde": 0.08, "gialla": 0.08, "blu": 0.1},
        "lines": lines,
    }
    OUT.write_text(json.dumps(payload, separators=(",", ":")))
    print("wrote", OUT, OUT.stat().st_size)


if __name__ == "__main__":
    main()
