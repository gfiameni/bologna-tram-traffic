#!/usr/bin/env python3
"""Build Linea Rossa corridor geometry from OpenStreetMap streets.

The public driving router detours between carriageways, so the paths are
shortest routes on the named streets the tram follows. Output: public/network.json.
"""

import json
import math
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "public" / "network.json"
UA = "bologna-tram-traffic/1.0 (local educational simulation)"

TRUNK = [
    ("emilio-lepido", "Emilio Lepido", 44.52323, 11.26218),
    ("villaggio-ina", "Villaggio Ina", 44.52104, 11.26473),
    ("ducati", "Ducati", 44.51920, 11.27010),
    ("manuzio", "Manuzio", 44.51686, 11.27680),
    ("borgo-panigale", "Stazione Borgo Panigale", 44.51433, 11.28380),
    ("triumvirato", "Triumvirato", 44.51142, 11.28944),
    ("pontelungo", "Pontelungo", 44.50893, 11.29650),
    ("santa-viola", "Santa Viola", 44.50702, 11.30510),
    ("prati-di-caprara", "Prati di Caprara", 44.50528, 11.31018),
    ("ospedale-maggiore", "Ospedale Maggiore", 44.50378, 11.31452),
    ("saffi", "Saffi", 44.50183, 11.32001),
    ("porta-san-felice", "Porta San Felice", 44.49898, 11.32803),
    ("paladozza", "Paladozza", 44.49792, 11.33164),
    ("canale-di-reno", "Canale di Reno", 44.49852, 11.33513),
    ("ugo-bassi", "Ugo Bassi", 44.49558, 11.33830),
    ("piazza-maggiore", "Piazza Maggiore", 44.49696, 11.34318),
    ("indipendenza", "Indipendenza", 44.50086, 11.34429),
    ("stazione-centrale", "Stazione Centrale", 44.50433, 11.34528),
    ("matteotti", "Matteotti", 44.50711, 11.34613),
    ("piazza-unita", "Piazza dell'Unità", 44.50964, 11.34690),
    ("zucca", "Zucca", 44.51148, 11.34825),
    ("stalingrado", "Stalingrado", 44.51058, 11.35680),
]
FIERA = [
    ("aldo-moro", "Aldo Moro", 44.50953, 11.36202),
    ("viale-fiera", "Viale della Fiera", 44.50744, 11.36771),
    ("michelino", "Michelino", 44.51207, 11.37070),
]
PILASTRO = [
    ("repubblica", "Repubblica", 44.50593, 11.36150),
    ("spadolini", "Piazza Spadolini", 44.50389, 11.36680),
    ("san-donato", "San Donato", 44.50528, 11.37168),
    ("san-donnino", "San Donnino", 44.50787, 11.37683),
    ("san-giorgio", "Villaggio San Giorgio", 44.51136, 11.38562),
    ("pirandello", "Pirandello", 44.51126, 11.39158),
    ("pilastro", "Pilastro", 44.51040, 11.39620),
    ("sighinolfi", "Sighinolfi", 44.51120, 11.40115),
    ("agraria", "Facoltà di Agraria", 44.51376, 11.40589),
]

TRAM_NAMES = {
    "Via Marco Emilio Lepido",
    "Via Emilia Ponente",
    "Via Aurelio Saffi",
    "Via San Felice",
    "Piazza di Porta San Felice",
    "Via Riva di Reno",
    "Via Ugo Bassi",
    "Via Rizzoli",
    "Via dell'Indipendenza",
    "Piazza Venti Settembre",
    "Via Giacomo Matteotti",
    "Via Ferrarese",
    "Via Giuseppe Mazza",
    "Via Stalingrado",
    "Viale Aldo Moro",
    "Viale della Fiera",
    "Via della Liberazione",
    "Viale della Repubblica",
    "Via San Donato",
    "Via Luigi Pirandello",
    "Via del Pilastro",
    "Via Italo Svevo",
    "Via Larga",
    "Via Lino Sighinolfi",
    "Viale Tito Carnacini",
    "Rotonda Augusto Baroni",
    "Rotonda Luchino Visconti",
    "Via Trattati Comunitari Europei 1957-2007",
    "Viale Giuseppe Fanin",
}
BYPASS_NAMES = {
    "Via San Felice",
    "Piazza di Porta San Felice",
    "Via delle Lame",
    "Via Riva di Reno",
    "Via Guglielmo Marconi",
    "Via Giovanni Amendola",
    "Viale Pietro Pietramellara",
    "Via Milazzo",
    "Via Giacomo Matteotti",
}
ROAD = {
    "primary",
    "secondary",
    "tertiary",
    "residential",
    "unclassified",
    "pedestrian",
    "living_street",
    "primary_link",
    "secondary_link",
    "tertiary_link",
    "trunk",
    "service",
}


def hav(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1, h)))


def length(line):
    return sum(hav(a, b) for a, b in zip(line, line[1:]))


def overpass(query):
    raw = subprocess.check_output(
        [
            "curl",
            "-sS",
            "-A",
            UA,
            "--fail",
            "--max-time",
            "90",
            "https://overpass-api.de/api/interpreter",
            "--data-urlencode",
            f"data={query}",
        ],
        timeout=100,
    )
    data = json.loads(raw)
    if "elements" not in data:
        raise SystemExit(data.get("remark") or "overpass failed")
    return data["elements"]


def fetch_ways():
    elements = []
    for name in ("streets.json", "extra-streets.json"):
        path = ROOT / "scripts" / name
        if path.exists() and path.stat().st_size > 100:
            elements.extend(json.loads(path.read_text()))
            print(f"cached {name} {len(elements)} cumulative")
    if not elements:
        names = sorted(TRAM_NAMES | BYPASS_NAMES)
        bbox = "(44.492,11.255,44.530,11.420)"
        # Exact name lookups use the index; a big regex times out.
        clauses = "\n".join(f'  way["name"="{name}"]{bbox};' for name in names)
        query = f"[out:json][timeout:60];\n(\n{clauses}\n);\nout geom;"
        elements = overpass(query)
        (ROOT / "scripts" / "streets.json").write_text(json.dumps(elements))
        print(f"downloaded streets {len(elements)}")
    ways = []
    for el in elements:
        tags = el.get("tags") or {}
        if tags.get("highway") not in ROAD:
            continue
        geom = [(p["lon"], p["lat"]) for p in el.get("geometry") or []]
        if len(geom) < 2:
            continue
        ways.append({"name": tags.get("name"), "geom": geom})
    print(f"loaded {len(ways)} ways")
    return ways


class Graph:
    def __init__(self, ways, hop_m=34, join_m=42):
        self.nodes = {}
        self.edges = {}
        self.tol = 0.00008

        def add_node(lon, lat):
            key = (round(lon / self.tol) * self.tol, round(lat / self.tol) * self.tol)
            self.nodes.setdefault(key, (lon, lat))
            return key

        def link(a, b, dist):
            if a == b or dist <= 0.5:
                return
            self.edges.setdefault(a, []).append((b, dist))
            self.edges.setdefault(b, []).append((a, dist))

        named = {}
        for way in ways:
            keys = [add_node(lon, lat) for lon, lat in way["geom"]]
            named.setdefault(way["name"], set()).update(keys)
            for a, b in zip(keys, keys[1:]):
                link(a, b, hav(self.nodes[a], self.nodes[b]))

        for keys in named.values():
            buckets = {}
            for key in keys:
                lon, lat = self.nodes[key]
                bk = (round(lon / 0.00045), round(lat / 0.00045))
                buckets.setdefault(bk, []).append(key)
            key_list = list(keys)
            for key in key_list:
                lon, lat = self.nodes[key]
                bk = (round(lon / 0.00045), round(lat / 0.00045))
                near = []
                for dx in (-1, 0, 1):
                    for dy in (-1, 0, 1):
                        near.extend(buckets.get((bk[0] + dx, bk[1] + dy), []))
                for other in near:
                    if other <= key:
                        continue
                    dist = hav(self.nodes[key], self.nodes[other])
                    if 6 < dist <= hop_m:
                        link(key, other, dist * 1.12)

        # Join different street names where they actually meet.
        all_keys = list(self.nodes)
        buckets = {}
        for key in all_keys:
            lon, lat = self.nodes[key]
            bk = (round(lon / 0.0005), round(lat / 0.0005))
            buckets.setdefault(bk, []).append(key)
        joined = 0
        for key in all_keys:
            lon, lat = self.nodes[key]
            bk = (round(lon / 0.0005), round(lat / 0.0005))
            near = []
            for dx in (-1, 0, 1):
                for dy in (-1, 0, 1):
                    near.extend(buckets.get((bk[0] + dx, bk[1] + dy), []))
            for other in near:
                if other <= key:
                    continue
                dist = hav((lon, lat), self.nodes[other])
                if dist <= join_m and not self._linked(key, other):
                    link(key, other, dist * 1.25)
                    joined += 1
        print(f"graph nodes {len(self.nodes)} join bridges {joined}")

    def _linked(self, a, b):
        return any(other == b for other, _ in self.edges.get(a, []))

    def nearest(self, lon, lat, max_m=70):
        best = None
        best_d = max_m
        for key, point in self.nodes.items():
            dist = hav((lon, lat), point)
            if dist < best_d:
                best_d = dist
                best = key
        return best, best_d

    def shortest(self, start, goal):
        import heapq

        dist = {start: 0}
        prev = {}
        heap = [(0, start)]
        while heap:
            d, node = heapq.heappop(heap)
            if node == goal:
                break
            if d != dist.get(node):
                continue
            for nxt, w in self.edges.get(node, []):
                nd = d + w
                if nd < dist.get(nxt, 1e18):
                    dist[nxt] = nd
                    prev[nxt] = node
                    heapq.heappush(heap, (nd, nxt))
        if goal not in dist:
            return None
        path = [goal]
        while path[-1] != start:
            path.append(prev[path[-1]])
        path.reverse()
        return [self.nodes[k] for k in path]

    def bridge_names(self, ways, pairs, max_m=230):
        """Connect named streets that meet at a roundabout the graph would otherwise split."""
        by = {}
        for way in ways:
            by.setdefault(way["name"], []).extend(way["geom"])
        for left, right in pairs:
            best = None
            for a in by.get(left, []):
                for b in by.get(right, []):
                    dist = hav(a, b)
                    if best is None or dist < best[0]:
                        best = (dist, a, b)
            if not best or best[0] > max_m:
                print(f"  bridge skip {left} — {right}: {best[0] if best else 'missing':}")
                continue
            ka, _ = self.nearest(best[1][0], best[1][1], max_m=40)
            kb, _ = self.nearest(best[2][0], best[2][1], max_m=40)
            if ka is None or kb is None:
                print(f"  bridge unsnapped {left} — {right}")
                continue
            self.edges.setdefault(ka, []).append((kb, best[0]))
            self.edges.setdefault(kb, []).append((ka, best[0]))
            print(f"  bridge {left} — {right}: {best[0]:.0f} m")


def through(graph, anchors):
    line = []
    for a, b in zip(anchors, anchors[1:]):
        ka, da = graph.nearest(a[3], a[2])
        kb, db = graph.nearest(b[3], b[2])
        straight = hav((a[3], a[2]), (b[3], b[2]))
        if ka is None or kb is None:
            print(f"  MISS {a[1]} ({da}) -> {b[1]} ({db})")
            continue
        path = graph.shortest(ka, kb)
        if not path:
            print(f"  GAP  {a[1]} -> {b[1]} straight {straight:.0f}")
            continue
        dist = length(path)
        ratio = dist / straight if straight > 1 else 1
        flag = "  !" if ratio > 1.85 and straight > 180 else ""
        print(f"  {a[1][:22]:22} -> {b[1][:22]:22} {dist:6.0f} m  x{ratio:.2f}{flag}")
        if line and path:
            if hav(line[-1], path[0]) < 25:
                path = path[1:]
        line.extend(path)
    return line


def resample(line, step=16):
    if len(line) < 2:
        return line
    out = [line[0]]
    acc = 0
    for a, b in zip(line, line[1:]):
        seg = hav(a, b)
        if seg < 0.4:
            continue
        pos = step - acc
        while pos <= seg:
            t = pos / seg
            out.append((a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t))
            pos += step
        acc = seg - (pos - step)
    if hav(out[-1], line[-1]) > 1:
        out.append(line[-1])
    return out


def clip_from(line, lon, lat):
    """Drop the start of a line until the closest point to lon/lat."""
    best_i = 0
    best_d = 1e18
    for i, p in enumerate(line):
        d = hav(p, (lon, lat))
        if d < best_d:
            best_d = d
            best_i = i
    return line[best_i:], best_d


def clip_until(line, lon, lat):
    best_i = len(line) - 1
    best_d = 1e18
    for i, p in enumerate(line):
        d = hav(p, (lon, lat))
        if d < best_d:
            best_d = d
            best_i = i
    return line[: best_i + 1], best_d


def svg(lines, stops, path):
    pts = [p for line in lines.values() for p in line]
    lons = [p[0] for p in pts]
    lats = [p[1] for p in pts]
    pad = 0.003
    minx, maxx = min(lons) - pad, max(lons) + pad
    miny, maxy = min(lats) - pad, max(lats) + pad
    w, h = 980, 760

    def xy(lon, lat):
        return (lon - minx) / (maxx - minx) * w, (maxy - lat) / (maxy - miny) * h

    colors = {
        "tram-trunk": "#e10600",
        "tram-fiera": "#ff6a3d",
        "tram-pilastro": "#8c1c13",
        "car-trunk": "#1f4e79",
        "car-bypass": "#d97706",
        "car-city": "#1f4e79",
        "car-fiera": "#5b8eae",
        "car-pilastro": "#7aa2c4",
    }
    body = [
        f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
        '<rect width="100%" height="100%" fill="#f4efe6"/>',
    ]
    for name, line in lines.items():
        if len(line) < 2:
            continue
        pts_s = " ".join(f"{xy(*p)[0]:.1f},{xy(*p)[1]:.1f}" for p in line)
        dash = ' stroke-dasharray="7 5"' if "bypass" in name else ""
        body.append(
            f'<polyline fill="none" stroke="{colors.get(name, "#333")}" stroke-width="3"{dash} points="{pts_s}"/>'
        )
    for stop in stops:
        x, y = xy(stop["lon"], stop["lat"])
        body.append(f'<circle cx="{x:.1f}" cy="{y:.1f}" r="2.6" fill="#1a1916"/>')
    body.append("</svg>")
    path.write_text("\n".join(body))


def dump(line):
    return [[round(lon, 6), round(lat, 6)] for lon, lat in line]


def main():
    ways = fetch_ways()
    tram_ways = [w for w in ways if w["name"] in TRAM_NAMES]
    bypass_ways = [w for w in ways if w["name"] in BYPASS_NAMES]
    print("tram graph")
    tram = Graph(tram_ways)
    tram.bridge_names(
        tram_ways,
        [
            ("Via Larga", "Viale Giuseppe Fanin"),
            ("Viale Tito Carnacini", "Viale Giuseppe Fanin"),
            ("Viale Tito Carnacini", "Rotonda Augusto Baroni"),
            ("Via San Donato", "Viale Tito Carnacini"),
            ("Via Larga", "Via Luigi Pirandello"),
        ],
    )
    print("bypass graph")
    bypass = Graph(bypass_ways, hop_m=36, join_m=70)
    bypass.bridge_names(
        bypass_ways,
        [
            ("Via Guglielmo Marconi", "Via Giovanni Amendola"),
            ("Via Milazzo", "Via Giacomo Matteotti"),
            ("Viale Pietro Pietramellara", "Via Giacomo Matteotti"),
        ],
        max_m=260,
    )

    print("tram trunk")
    tram_full = resample(through(tram, TRUNK))
    fork = TRUNK[-1]
    tram_trunk, fork_d = clip_until(tram_full, fork[3], fork[2])
    print(f"fork off tram trunk {fork_d:.0f} m, trunk {length(tram_trunk)/1000:.2f} km")

    print("tram fiera")
    fiera_line = resample(through(tram, [fork] + FIERA))
    fiera_line, _ = clip_from(fiera_line, fork[3], fork[2])
    fiera_line, michelino_d = clip_until(fiera_line, FIERA[-1][3], FIERA[-1][2])
    if michelino_d > 35:
        fiera_line = fiera_line + [(FIERA[-1][3], FIERA[-1][2])]
    print(f"fiera spur {length(fiera_line)/1000:.2f} km, michelino off {michelino_d:.0f} m")

    print("tram pilastro")
    pil_line = resample(through(tram, [fork] + PILASTRO))
    pil_line, _ = clip_from(pil_line, fork[3], fork[2])
    print(f"pilastro spur {length(pil_line)/1000:.2f} km")

    west_end = ("porta-san-felice", "Porta San Felice", TRUNK[11][2], TRUNK[11][3])
    rejoin = next(stop for stop in TRUNK if stop[0] == "matteotti")
    print("car west")
    car_trunk = resample(through(tram, TRUNK[:12]))
    car_trunk, _ = clip_until(car_trunk, west_end[3], west_end[2])
    print(f"car trunk {length(car_trunk)/1000:.2f} km")

    print("car bypass (around the historic centre)")
    car_bypass = resample(through(bypass, [west_end, rejoin]))
    print(f"car bypass {length(car_bypass)/1000:.2f} km")

    def slice_between(line, start, end):
        def nearest_index(lon, lat):
            best_i, best_d = 0, 1e18
            for i, point in enumerate(line):
                dist = hav(point, (lon, lat))
                if dist < best_d:
                    best_i, best_d = i, dist
            return best_i

        i0 = nearest_index(start[3], start[2])
        i1 = nearest_index(end[3], end[2])
        if i1 < i0:
            i0, i1 = i1, i0
        return line[i0 : i1 + 1]

    car_city = resample(slice_between(tram_trunk, rejoin, fork))
    print(f"car city {length(car_city)/1000:.2f} km")

    # East spurs share the tram alignment: that is where the tracks replace a lane.
    car_fiera = fiera_line
    car_pil = pil_line

    # Stub the west terminus onto the line if the named street starts short of it.
    origin = (TRUNK[0][3], TRUNK[0][2])
    if tram_trunk and hav(tram_trunk[0], origin) > 30:
        tram_trunk = [origin] + tram_trunk
    if car_trunk and hav(car_trunk[0], origin) > 30:
        car_trunk = [origin] + car_trunk

    lines = {
        "tram-trunk": tram_trunk,
        "tram-fiera": fiera_line,
        "tram-pilastro": pil_line,
        "car-trunk": car_trunk,
        "car-bypass": car_bypass,
        "car-city": car_city,
        "car-fiera": car_fiera,
        "car-pilastro": car_pil,
    }
    for name, line in lines.items():
        print(f"{name:16} {length(line)/1000:.2f} km")

    stops = []
    for sid, name, lat, lon in TRUNK:
        stops.append({"id": sid, "name": name, "lat": lat, "lon": lon, "branch": "trunk"})
    for sid, name, lat, lon in FIERA:
        stops.append({"id": sid, "name": name, "lat": lat, "lon": lon, "branch": "fiera"})
    for sid, name, lat, lon in PILASTRO:
        stops.append({"id": sid, "name": name, "lat": lat, "lon": lon, "branch": "pilastro"})

    def along(line, lon, lat):
        best_s = 0
        best_d = 1e18
        s = 0
        for a, b in zip(line, line[1:]):
            seg = hav(a, b) or 1e-6
            ax, ay = a
            bx, by = b
            scale = math.cos(math.radians(ay))
            vx, vy = (bx - ax) * scale, by - ay
            wx, wy = (lon - ax) * scale, lat - ay
            den = vx * vx + vy * vy or 1e-12
            t = max(0, min(1, (wx * vx + wy * vy) / den))
            proj = (ax + (bx - ax) * t, ay + (by - ay) * t)
            d = hav((lon, lat), proj)
            if d < best_d:
                best_d = d
                best_s = s + seg * t
            s += seg
        return best_s, best_d

    screen_s, screen_d = along(tram_trunk, TRUNK[11][3], TRUNK[11][2])
    print(f"screenline {screen_s:.0f} m along tram trunk, off by {screen_d:.0f} m")

    payload = {
        "attribution": "Street and stop geometry © OpenStreetMap contributors.",
        "stops": stops,
        "pieces": {
            "tram": {
                "trunk": dump(tram_trunk),
                "fiera": dump(fiera_line),
                "pilastro": dump(pil_line),
            },
            "car": {
                "trunk": dump(car_trunk),
                "bypass": dump(car_bypass),
                "city": dump(car_city),
                "fiera": dump(car_fiera),
                "pilastro": dump(car_pil),
            },
        },
        "affected": {
            "car": {
                "trunk": True,
                "bypass": False,
                "city": True,
                "fiera": True,
                "pilastro": True,
            }
        },
        "screenline": {"name": "Porta San Felice", "tramTrunkM": round(screen_s, 1)},
    }
    OUT.write_text(json.dumps(payload))
    svg(lines, stops, ROOT / "scripts" / "preview.svg")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
