#!/usr/bin/env python3
"""Build public/roads.json: Bologna's main roads with lanes, signals, tram lines, and car counts.

Roads are OpenStreetMap trunk, primary, secondary and tertiary ways. Motorways and streets
closed to private cars are left out. Counts come from the Comune di Bologna loop detectors
(rilevazione-flusso-veicoli-tramite-spire-anno-2026, CC BY 4.0). Each detector covers one
lane. A road's flow is the median of each hour over the school-term Tuesdays to Thursdays
of May and late September 2026, per lane. A road without a detector borrows the nearest
measured stretch of the same street, or the median of its road class.

Each road on a tram line lists the stretches of line it sits on, and each road running
alongside a line, 80 m to 1.2 km away, lists its share of the cars that line pushes off
its street.
"""
import csv
import json
import math
import statistics
import subprocess
from collections import defaultdict
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "public" / "roads.json"
UA = "bologna-tram-traffic/1.0 (educational corridor model)"
BBOX = "44.445,11.245,44.555,11.415"
OVERPASS = (
    "https://overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.openstreetmap.fr/api/interpreter",
)
SPIRE = "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/rilevazione-flusso-veicoli-tramite-spire-anno-2026/exports/csv"
SPIRE_PAGE = "https://opendata.comune.bologna.it/explore/dataset/rilevazione-flusso-veicoli-tramite-spire-anno-2026/"
PERIODS = (("2026-05-04", "2026-05-29"), ("2026-09-15", "2026-09-30"))
TYPICAL = {"Martedì", "Mercoledì", "Giovedì"}
WEEKDAYS = TYPICAL | {"Lunedì", "Venerdì"}
CLASSES = ("trunk", "primary", "secondary", "tertiary")
CLOSED = {"no", "permit", "private", "destination", "delivery", "psv", "bus", "agricultural", "forestry"}
DEFAULT_LANES = {"trunk": 2, "primary": 2, "secondary": 1, "tertiary": 1}
COMPASS = {"N": 0, "NE": 45, "E": 90, "SE": 135, "S": 180, "SO": 225, "O": 270, "NO": 315}
GENERIC = {"VIA", "VIALE", "PIAZZA", "PIAZZALE", "LARGO", "PORTA", "PONTE", "STRADA", "DEL", "DELLA", "DELLE",
           "DEI", "DEGLI", "DELL", "DI", "DA", "DE", "SAN", "SANTA", "SANTO", "SS", "LUNGO", "TANGENZIALE"}
LANE_MAX = 2000
MATCH_M = 30.0
SIGNAL_M = 12.0
TRAM_M = 28.0
TRAM_SHARE = 0.6
SPILL_MIN_M = 80.0
SPILL_M = 1200.0
SPILL_DEG = 35.0
BIN_M = 300.0
STUB_M = 40.0
PIECE_M = 100.0
LAT0, LON0 = 44.5, 11.33
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110574.0


def overpass(query, dest):
    if dest.exists() and dest.stat().st_size > 1000:
        return json.loads(dest.read_text())
    for host in OVERPASS:
        try:
            body = subprocess.check_output(["curl", "-sS", "-L", "-A", UA, "--max-time", "200", host,
                                            "--data-urlencode", f"data={query}"])
        except subprocess.CalledProcessError:
            continue
        if body.lstrip().startswith(b"{"):
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(body)
            return json.loads(body)
    raise SystemExit("Overpass did not answer")


def spire_rows():
    rows = []
    for first, last in PERIODS:
        dest = RAW / f"spire-{first[:7]}.csv"
        if not (dest.exists() and dest.stat().st_size > 1000):
            dest.parent.mkdir(parents=True, exist_ok=True)
            subprocess.check_call(["curl", "-sS", "--max-time", "300", "-G", SPIRE,
                                   "--data-urlencode", f"where=data >= date'{first}' AND data <= date'{last}'",
                                   "--data-urlencode", "delimiter=;", "-o", str(dest)])
        with dest.open(encoding="utf-8-sig") as handle:
            rows.extend(row for row in csv.DictReader(handle, delimiter=";") if first <= row["data"] <= last)
    return rows


def project(lat, lon):
    return ((np.asarray(lon) - LON0) * KX, (np.asarray(lat) - LAT0) * KY)


def angle_gap(a, b, period=360.0):
    gap = abs((a - b) % period)
    return min(gap, period - gap)


def bearing(dx, dy):
    return math.degrees(math.atan2(dx, dy)) % 360


def nearest_on(points, polyline):
    """Distance from each point to a polyline, with the chainage and direction there."""
    a = polyline[:-1]
    step = polyline[1:] - a
    size = (step ** 2).sum(1)
    rel = points[:, None, :] - a[None, :, :]
    t = np.clip((rel * step[None]).sum(2) / np.where(size > 0, size, 1)[None], 0, 1)
    gap = rel - t[..., None] * step[None]
    dist = np.hypot(gap[..., 0], gap[..., 1])
    index = dist.argmin(1)
    rows = np.arange(len(points))
    lengths = np.sqrt(size)
    start = np.concatenate([[0], np.cumsum(lengths)])[:-1]
    chain = start[index] + t[rows, index] * lengths[index]
    heading = np.degrees(np.arctan2(step[index, 0], step[index, 1])) % 360
    return dist[rows, index], chain, heading


def along(polyline, spacing):
    """Points every `spacing` metres along a polyline, with the length each one stands for."""
    lengths = np.hypot(*np.diff(polyline, axis=0).T)
    total = float(lengths.sum())
    count = max(1, int(math.ceil(total / spacing)))
    marks = (np.arange(count) + 0.5) * total / count
    cum = np.concatenate([[0], np.cumsum(lengths)])
    x = np.interp(marks, cum, polyline[:, 0])
    y = np.interp(marks, cum, polyline[:, 1])
    return np.column_stack([x, y]), total / count, total


def simplify(points, tolerance):
    """Douglas-Peucker on projected points; returns the indices kept."""
    keep = np.zeros(len(points), dtype=bool)
    keep[0] = keep[-1] = True
    stack = [(0, len(points) - 1)]
    while stack:
        first, last = stack.pop()
        if last - first < 2:
            continue
        a, b = points[first], points[last]
        step = b - a
        size = float(step @ step)
        rel = points[first + 1:last] - a
        if size == 0:
            dist = np.hypot(rel[:, 0], rel[:, 1])
        else:
            dist = np.abs(rel[:, 0] * step[1] - rel[:, 1] * step[0]) / math.sqrt(size)
        worst = int(dist.argmax())
        if dist[worst] > tolerance:
            middle = first + 1 + worst
            keep[middle] = True
            stack.append((first, middle))
            stack.append((middle, last))
    return np.flatnonzero(keep)


def encode(coords):
    """Google encoded polyline, five decimals."""
    out = []
    prev = [0, 0]
    for lat, lon in coords:
        for i, value in enumerate((lat, lon)):
            number = int(round(value * 1e5))
            delta = number - prev[i]
            prev[i] = number
            delta = ~(delta << 1) if delta < 0 else delta << 1
            while delta >= 0x20:
                out.append(chr((0x20 | (delta & 0x1F)) + 63))
                delta >>= 5
            out.append(chr(delta + 63))
    return "".join(out)


def tokens(name):
    clean = "".join(ch if ch.isalnum() else " " for ch in name.upper().replace("'", " "))
    return {word for word in clean.split() if len(word) > 2 and word not in GENERIC}


def car_lanes(tags, direction, count):
    """Lanes cars can use in one direction, after bus lanes and closed lanes."""
    suffixes = (f":{direction}", "") if direction else ("",)
    usable = [True] * count
    for key, closed in (("psv:lanes", {"designated"}), ("bus:lanes", {"designated"}),
                        ("motor_vehicle:lanes", {"no"}), ("access:lanes", {"no"})):
        for suffix in suffixes:
            value = tags.get(key + suffix)
            if value is None:
                continue
            parts = value.split("|")
            if len(parts) != count:
                break
            for i, part in enumerate(parts):
                if part in closed:
                    usable[i] = False
            break
    return max(1, sum(usable))


def lanes_of(tags, kind):
    oneway = tags.get("oneway") in ("yes", "1", "-1") or tags.get("junction") == "roundabout"
    try:
        total = int(float(tags.get("lanes", "").split(";")[0]))
    except ValueError:
        total = None
    if oneway:
        count = total or DEFAULT_LANES[kind]
        return oneway, car_lanes(tags, None, count), 0
    try:
        forward = int(tags["lanes:forward"])
        backward = int(tags["lanes:backward"])
    except (KeyError, ValueError):
        forward = backward = max(1, (total or 2) // 2)
    return oneway, car_lanes(tags, "forward", max(1, forward)), car_lanes(tags, "backward", max(1, backward))


def load_roads():
    major = overpass(
        f'[out:json][timeout:120];(way["highway"~"^(trunk|primary|secondary)$"]({BBOX}););out geom tags;'
        f'node["highway"="traffic_signals"]({BBOX});out;',
        RAW / "roads-osm.json")
    minor = overpass(f'[out:json][timeout:120];(way["highway"="tertiary"]({BBOX}););out geom tags;',
                     RAW / "roads-osm-tertiary.json")
    signals = [(e["lat"], e["lon"]) for e in major["elements"] if e["type"] == "node"]
    roads = []
    for element in major["elements"] + minor["elements"]:
        if element["type"] != "way" or len(element.get("geometry", [])) < 2:
            continue
        tags = element["tags"]
        kind = tags.get("highway")
        if kind not in CLASSES:
            continue
        if any(tags.get(key) in CLOSED for key in ("access", "motor_vehicle", "motorcar", "vehicle")):
            continue
        coords = [(point["lat"], point["lon"]) for point in element["geometry"]]
        if tags.get("oneway") == "-1":
            coords.reverse()
        oneway, forward, backward = lanes_of(tags, kind)
        x, y = project([c[0] for c in coords], [c[1] for c in coords])
        roads.append({
            "id": element["id"], "name": tags.get("name") or tags.get("ref") or "", "kind": kind,
            "coords": coords, "xy": np.column_stack([x, y]), "oneWay": oneway, "lanes": [forward, backward],
            "roundabout": tags.get("junction") in ("roundabout", "circular"),
        })
    sx, sy = project([s[0] for s in signals], [s[1] for s in signals])
    return roads, np.column_stack([sx, sy])


def detectors(rows, slots):
    """Per-lane hourly medians for typical weekdays and the busiest hours seen, by detector.

    A detector whose code changed keeps its id_uni, so days are grouped by id_uni.
    """
    columns = [f"{hour:02d}_00_{hour + 1:02d}_00" for hour in range(24)]
    found = {}
    days = defaultdict(dict)
    for row in rows:
        code = row["id_uni"] or row["codice_spira"]
        if not row["latitudine"] or not row["longitudine"]:
            continue
        direction = row["direzione"].strip()
        if "(" in direction and "(veicoli)" not in direction:
            continue
        values = [int(float(row[c])) if row[c] not in ("", None) else 0 for c in columns]
        if sum(values) < 100 or max(values) > LANE_MAX:
            continue
        if code not in found:
            if row["angolo"].strip():
                heading = (360 - float(row["angolo"])) % 360
            else:
                heading = COMPASS.get(direction.split()[0]) if direction else None
            if heading is None:
                continue
            found[code] = {"code": code, "name": row["nome_via"], "lat": float(row["latitudine"]),
                           "lon": float(row["longitudine"]), "heading": heading,
                           "station": " ".join(row["codice_spira"].split()[:-1])}
        days[code][row["data"]] = (row["num_giorno_settimana"], values)
    out = []
    for code, item in found.items():
        typical = [values for weekday, values in days[code].values() if weekday in TYPICAL]
        if len(typical) < 4:
            continue
        busy = [values[hour] for weekday, values in days[code].values() if weekday in WEEKDAYS for hour in range(6, 22)]
        item["profile"] = [statistics.median(values[hour] for values in typical) for hour in slots]
        item["peak"] = float(np.percentile(busy, 98))
        item["days"] = len(typical)
        out.append(item)
    return out


def match(found, roads):
    starts, steps, owners = [], [], []
    for index, road in enumerate(roads):
        starts.append(road["xy"][:-1])
        steps.append(np.diff(road["xy"], axis=0))
        owners.append(np.full(len(road["xy"]) - 1, index))
    starts = np.concatenate(starts)
    steps = np.concatenate(steps)
    owners = np.concatenate(owners)
    size = (steps ** 2).sum(1)
    heading = np.degrees(np.arctan2(steps[:, 0], steps[:, 1])) % 360
    matched = 0
    for item in found:
        px, py = project(item["lat"], item["lon"])
        rel = np.array([px, py]) - starts
        t = np.clip((rel * steps).sum(1) / np.where(size > 0, size, 1), 0, 1)
        dist = np.hypot(*(rel - t[:, None] * steps).T)
        best = None
        for seg in np.flatnonzero(dist <= MATCH_M):
            road = roads[owners[seg]]
            gap = angle_gap(item["heading"], heading[seg])
            if gap <= 60:
                side, turn = 0, gap
            elif not road["oneWay"] and gap >= 120:
                side, turn = 1, 180 - gap
            else:
                continue
            named = bool(tokens(item["name"]) & tokens(road["name"]))
            score = dist[seg] + (0 if named else 20) + 0.2 * turn
            if best is None or score < best[0]:
                best = (score, owners[seg], side)
        if best:
            roads[best[1]].setdefault("found", [[], []])[best[2]].append(item)
            matched += 1
    return matched


def flows(roads, slots):
    profiles = []
    measured = defaultdict(list)
    for index, road in enumerate(roads):
        road["flow"] = [-1, -1]
        road["measured"] = [False, False]
        for side, items in enumerate(road.get("found", [[], []])):
            if not items or road["lanes"][side] == 0:
                continue
            stations = defaultdict(list)
            for item in items:
                stations[item["station"]].append(item)
            lane_profiles = [np.mean([item["profile"] for item in group], axis=0) for group in stations.values()]
            peaks = [np.mean([item["peak"] for item in group]) for group in stations.values()]
            profile = np.mean(lane_profiles, axis=0)
            profiles.append({"cars": [int(round(v)) for v in profile], "peak": int(round(float(np.mean(peaks))))})
            road["flow"][side] = len(profiles) - 1
            road["measured"][side] = True
            measured[road["kind"]].append(len(profiles) - 1)
    defaults = {}
    for kind in CLASSES:
        pool = [profiles[i] for i in measured[kind]] or profiles
        profiles.append({"cars": [int(round(statistics.median(p["cars"][s] for p in pool))) for s in range(len(slots))],
                         "peak": int(round(statistics.median(p["peak"] for p in pool)))})
        defaults[kind] = len(profiles) - 1
    by_name = defaultdict(list)
    for road in roads:
        if road["name"] and any(road["measured"]):
            by_name[road["name"]].append(road)
    for road in roads:
        middle = road["xy"].mean(0)
        heading = bearing(*(road["xy"][-1] - road["xy"][0]))
        for side in (0, 1):
            if road["lanes"][side] == 0 or road["measured"][side]:
                continue
            travel = (heading + 180 * side) % 360
            best = None
            for other in by_name.get(road["name"], []):
                distance = float(np.hypot(*(other["xy"].mean(0) - middle)))
                if distance > 1500:
                    continue
                other_heading = bearing(*(other["xy"][-1] - other["xy"][0]))
                for other_side in (0, 1):
                    if not other["measured"][other_side]:
                        continue
                    turn = angle_gap(travel, (other_heading + 180 * other_side) % 360)
                    score = distance + (0 if turn <= 60 else 1000)
                    if best is None or score < best[0]:
                        best = (score, other["flow"][other_side])
            road["flow"][side] = best[1] if best else defaults[road["kind"]]
    return profiles, defaults


def count_signals(roads, signals):
    for road in roads:
        points = road["xy"]
        low, high = points.min(0) - SIGNAL_M, points.max(0) + SIGNAL_M
        near = signals[(signals[:, 0] >= low[0]) & (signals[:, 0] <= high[0]) &
                       (signals[:, 1] >= low[1]) & (signals[:, 1] <= high[1])]
        if not len(near):
            road["signals"] = 0
            continue
        dist, _, _ = nearest_on(near, points)
        road["signals"] = int((dist <= SIGNAL_M).sum())


def polylines(latlon_lists):
    out = []
    for coords in latlon_lists:
        x, y = project([c[0] for c in coords], [c[1] for c in coords])
        out.append(np.column_stack([x, y]))
    return out


def overlap(road, lines):
    samples, _, _ = along(road["xy"], 15.0)
    best = 0.0
    for line in lines:
        if len(line) < 2:
            continue
        dist, _, _ = nearest_on(samples, line)
        best = max(best, float((dist <= TRAM_M).mean()))
    return best


def tag_lines(roads, tram_lines, car_pieces):
    for road in roads:
        road["tram"] = [name for name, lines in tram_lines.items() if overlap(road, lines) >= TRAM_SHARE]
        shares = {name: overlap(road, [line]) for name, line in car_pieces.items()}
        name, share = max(shares.items(), key=lambda item: item[1])
        road["piece"] = name if share >= TRAM_SHARE else None


def spill(roads, tram_lines):
    """Stretches of each line, the roads on them, and the parallel roads that take displaced cars."""
    bins = []
    keys = {}
    pieces = []
    for index, road in enumerate(roads):
        points, each, _ = along(road["xy"], PIECE_M)
        heading = bearing(*(road["xy"][-1] - road["xy"][0]))
        for point in points:
            pieces.append((index, point, each, heading))
    owners = np.array([p[0] for p in pieces])
    points = np.array([p[1] for p in pieces])
    lengths = np.array([p[2] for p in pieces])
    headings = np.array([p[3] for p in pieces])
    for road in roads:
        road["tramBins"] = defaultdict(float)
        road["spillWeights"] = defaultdict(float)
    for line_index, (name, lines) in enumerate(tram_lines.items()):
        on_line = np.array([name in roads[i]["tram"] or (name == "rossa" and roads[i]["piece"] not in (None, "bypass"))
                            for i in owners])
        best = np.full(len(points), np.inf)
        best_bin = np.full(len(points), -1)
        best_heading = np.zeros(len(points))
        for segment_index, line in enumerate(lines):
            if len(line) < 2:
                continue
            dist, chain, heading = nearest_on(points, line)
            closer = dist < best
            best[closer] = dist[closer]
            best_heading[closer] = heading[closer]
            for i in np.flatnonzero(closer):
                key = (line_index, segment_index, int(chain[i] // BIN_M))
                if key not in keys:
                    keys[key] = len(bins)
                    bins.append(line_index)
                best_bin[i] = keys[key]
        totals = defaultdict(float)
        chosen = []
        for i in range(len(points)):
            road = roads[owners[i]]
            if on_line[i]:
                if best[i] <= TRAM_M * 2:
                    road["tramBins"][int(best_bin[i])] += float(lengths[i])
                continue
            if (road["piece"] or road["roundabout"] or road["length"] < STUB_M or not SPILL_MIN_M <= best[i] <= SPILL_M
                    or angle_gap(headings[i], best_heading[i], 180.0) > SPILL_DEG):
                continue
            lanes = sum(road["lanes"])
            weight = lanes / (1 + best[i] / 400.0)
            totals[int(best_bin[i])] += weight * float(lengths[i])
            chosen.append((i, int(best_bin[i]), weight))
        for i, bin_id, weight in chosen:
            road = roads[owners[i]]
            share = min(1.0, weight * BIN_M / totals[bin_id])
            road["spillWeights"][bin_id] += share * float(lengths[i])
    for road in roads:
        length = road["length"]
        road["tramBins"] = [[b, int(round(m))] for b, m in sorted(road["tramBins"].items())]
        road["spill"] = [[b, round(m / length, 3)] for b, m in sorted(road["spillWeights"].items()) if m / length >= 0.002]
    return bins


def main():
    slots = [slot["hour"] for slot in json.loads((ROOT / "data" / "hours.json").read_text())["slots"]]
    roads, signals = load_roads()
    for road in roads:
        road["length"] = float(np.hypot(*np.diff(road["xy"], axis=0).T).sum())
    found = detectors(spire_rows(), slots)
    matched = match(found, roads)
    profiles, defaults = flows(roads, slots)
    count_signals(roads, signals)
    line_data = json.loads((ROOT / "public" / "lines.json").read_text())["lines"]
    tram_lines = {line["id"]: polylines(line["segments"]) for line in line_data}
    network = json.loads((ROOT / "public" / "network.json").read_text())
    car_pieces = {name: polylines([[(lat, lon) for lon, lat in coords]])[0]
                  for name, coords in network["pieces"]["car"].items()}
    tag_lines(roads, tram_lines, car_pieces)
    bins = spill(roads, tram_lines)
    names = sorted({road["name"] for road in roads})
    line_ids = list(tram_lines)
    piece_ids = list(car_pieces)
    columns = defaultdict(list)
    for road in roads:
        keep = simplify(road["xy"], 3.0)
        columns["name"].append(names.index(road["name"]))
        columns["kind"].append(CLASSES.index(road["kind"]))
        columns["path"].append(encode([road["coords"][i] for i in keep]))
        columns["length"].append(int(round(road["length"])))
        columns["oneWay"].append(int(road["oneWay"]))
        columns["lanes"].append(road["lanes"])
        columns["signals"].append(road["signals"])
        columns["flow"].append(road["flow"])
        columns["measured"].append(int(road["measured"][0]) + 2 * int(road["measured"][1]))
        columns["tram"].append(sum(1 << line_ids.index(name) for name in road["tram"]))
        columns["piece"].append(piece_ids.index(road["piece"]) if road["piece"] else -1)
        columns["tramBins"].append(road["tramBins"])
        columns["spill"].append(road["spill"])
    measured_roads = sum(1 for road in roads if any(road["measured"]))
    days = sorted({row_day for first, last in PERIODS for row_day in (first, last)})
    data = {
        "attribution": "Roads © OpenStreetMap contributors (ODbL). Car counts © Comune di Bologna, loop detectors 2026 (CC BY 4.0).",
        "source": SPIRE_PAGE,
        "note": (f"{len(found)} detectors with a typical weekday, {matched} of them on these roads. Each detector covers one lane. "
                 f"Flows are the median of each hour over the school-term Tuesdays to Thursdays of {days[0]} to {days[1]} "
                 f"and {days[2]} to {days[3]}. A road without a detector borrows the nearest measured stretch of the same "
                 "street, or the median of its road class."),
        "hours": slots,
        "kinds": list(CLASSES),
        "lines": line_ids,
        "pieces": piece_ids,
        "bins": bins,
        "binM": BIN_M,
        "classes": defaults,
        "profiles": profiles,
        "names": names,
        "roads": columns,
    }
    OUT.write_text(json.dumps(data, ensure_ascii=False, separators=(",", ":")))
    print(f"{len(roads)} roads, {measured_roads} measured, {len(found)} detectors ({matched} matched), "
          f"{len(bins)} line stretches, {OUT.stat().st_size // 1024} KB")


if __name__ == "__main__":
    main()
