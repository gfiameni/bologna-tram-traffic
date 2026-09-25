#!/usr/bin/env python3
"""Download open data and attach it to the Linea Rossa corridor.

Sources, all public:
- OpenStreetMap traffic signals, cycleways, and bus stops
- Comune di Bologna loop detectors (traffico-viali)
- Comune di Bologna bicycle counters (colonnine-conta-bici)
- TPER GTFS for the Bologna bus network
"""

import csv
import json
import math
import subprocess
import zipfile
from collections import defaultdict
from io import TextIOWrapper
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "supply.json"
UA = "bologna-tram-traffic/1.0 (educational corridor model)"
SCREEN = (11.32803, 44.49898)


def curl(url, dest=None):
    cmd = ["curl", "-sS", "-L", "-A", UA, "--max-time", "180", url]
    if dest:
        if dest.exists() and dest.stat().st_size > 1000:
            print("cached", dest.name)
            return b""
        dest.parent.mkdir(parents=True, exist_ok=True)
        cmd.extend(["-o", str(dest)])
        subprocess.check_call(cmd)
        return b""
    return subprocess.check_output(cmd)


def hav(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    r = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp, dl = math.radians(lat2 - lat1), math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * r * math.asin(math.sqrt(min(1.0, h)))


def load_network():
    data = json.loads((ROOT / "public" / "network.json").read_text())
    pieces = {}
    for name, coords in data["pieces"]["car"].items():
        points = []
        travelled = 0.0
        points.append((coords[0][0], coords[0][1], 0.0))
        for a, b in zip(coords, coords[1:]):
            travelled += hav(a, b)
            points.append((b[0], b[1], travelled))
        pieces[name] = points
    return data, pieces


def project(points, lon, lat):
    best_s, best_d = 0.0, 1e18
    for (lon1, lat1, s0), (lon2, lat2, s1) in zip(points, points[1:]):
        scale = math.cos(math.radians(lat1))
        vx, vy = (lon2 - lon1) * scale, lat2 - lat1
        wx, wy = (lon - lon1) * scale, lat - lat1
        den = vx * vx + vy * vy or 1e-12
        t = max(0.0, min(1.0, (wx * vx + wy * vy) / den))
        proj = (lon1 + (lon2 - lon1) * t, lat1 + (lat2 - lat1) * t)
        dist = hav((lon, lat), proj)
        if dist < best_d:
            best_d = dist
            best_s = s0 + (s1 - s0) * t
    return best_s, best_d


def nearest_piece(pieces, lon, lat, max_m):
    best = None
    for name, points in pieces.items():
        s, dist = project(points, lon, lat)
        if dist <= max_m and (best is None or dist < best[0]):
            best = (dist, name, s)
    return best


def fetch_osm():
    path = RAW / "osm.json"
    if path.exists() and path.stat().st_size > 1000:
        print("cached osm.json")
        data = json.loads(path.read_text())
        print("osm elements", len(data["elements"]))
        return data["elements"]
    query = """
[out:json][timeout:90];
(
  node["highway"="traffic_signals"](44.49,11.25,44.53,11.42);
  node["highway"="bus_stop"](44.49,11.25,44.53,11.42);
  way["highway"="cycleway"](44.49,11.25,44.53,11.42);
  way["cycleway"~"lane|track|opposite_lane|opposite_track"](44.49,11.25,44.53,11.42);
);
out geom;
"""
    RAW.mkdir(parents=True, exist_ok=True)
    subprocess.check_call([
        "curl", "-sS", "-L", "-A", UA, "--max-time", "120",
        "https://overpass-api.de/api/interpreter",
        "--data-urlencode", f"data={query}",
        "-o", str(path),
    ])
    data = json.loads(path.read_text())
    if "elements" not in data:
        raise SystemExit(data.get("remark") or "overpass failed")
    print("osm elements", len(data["elements"]))
    return data["elements"]


def fetch_loops():
    path = RAW / "traffico-viali.csv"
    curl(
        "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/traffico-viali/exports/csv?delimiter=%3B&use_labels=false",
        path,
    )
    print("loops bytes", path.stat().st_size)
    rows = []
    with path.open(newline="", encoding="utf-8-sig") as handle:
        reader = csv.DictReader(handle, delimiter=";")
        for row in reader:
            if "feriale" not in (row.get("tipo_giorno") or ""):
                continue
            try:
                peak = float(row["8_00_8_30"]) + float(row["8_30_9_00"])
            except (KeyError, TypeError, ValueError):
                continue
            rows.append((row.get("via_spira") or "", row.get("direzione") or "", peak, row.get("data") or ""))
    return rows


def fetch_bikes():
    # 06:00–07:00 UTC is 08:00–09:00 in Bologna.
    url = (
        "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/colonnine-conta-bici/records"
        "?limit=100&offset={offset}&where="
        + "data%3E%3D%222026-09-23T06:00:00%22%20AND%20data%3C%222026-09-23T07:00:00%22"
    )
    records = []
    for offset in range(0, 800, 100):
        payload = json.loads(curl(url.format(offset=offset)))
        batch = payload.get("results") or []
        records.extend(batch)
        if len(batch) < 100:
            break
    print("bike records", len(records))
    return records


def fetch_gtfs():
    path = RAW / "gommagtfsbo.zip"
    if path.exists() and zipfile.is_zipfile(path):
        print("cached gtfs")
        dest = RAW / "gtfs"
        if not (dest / "stops.txt").exists():
            with zipfile.ZipFile(path) as archive:
                archive.extractall(dest)
        return dest
    url = (
        "https://solweb.tper.it/web/tools/open-data/open-data-download.aspx"
        "?source=solweb.tper.it&filename=gommagtfsbo&version=20260909&format=zip"
    )
    curl(url, path)
    print("gtfs bytes", path.stat().st_size)
    if path.stat().st_size < 1000 or zipfile.is_zipfile(path) is False:
        print("gtfs download was not a zip")
        return None
    dest = RAW / "gtfs"
    dest.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(path) as archive:
        archive.extractall(dest)
    return dest


def weekday_services(gtfs):
    services = set()
    with (gtfs / "calendar.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("wednesday") != "1":
                continue
            if row.get("start_date", "99999999") <= "20260923" <= row.get("end_date", "00000000"):
                services.add(row["service_id"])
    added, removed = set(), set()
    dates = gtfs / "calendar_dates.txt"
    if dates.exists():
        with dates.open(encoding="utf-8-sig", newline="") as handle:
            for row in csv.DictReader(handle):
                if row.get("date") != "20260923":
                    continue
                if row.get("exception_type") == "1":
                    added.add(row["service_id"])
                elif row.get("exception_type") == "2":
                    removed.add(row["service_id"])
    return (services | added) - removed


def buses_from_gtfs(gtfs, pieces):
    if gtfs is None:
        return None
    services = weekday_services(gtfs)
    print("wednesday services", len(services))
    near_stops = []
    with (gtfs / "stops.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            try:
                lon, lat = float(row["stop_lon"]), float(row["stop_lat"])
            except (KeyError, ValueError):
                continue
            if hav((lon, lat), SCREEN) > 160:
                continue
            near_stops.append((row["stop_id"], row.get("stop_name") or "", lon, lat))
    print("screenline stops", len(near_stops))
    if not near_stops:
        return None
    stop_ids = {item[0] for item in near_stops}
    trip_route = {}
    trip_service = {}
    with (gtfs / "trips.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("service_id") in services:
                trip_service[row["trip_id"]] = row["service_id"]
                trip_route[row["trip_id"]] = row.get("route_id")
    routes = {}
    with (gtfs / "routes.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            routes[row["route_id"]] = row.get("route_short_name") or row["route_id"]
    counts = defaultdict(set)
    lines = defaultdict(set)
    with (gtfs / "stop_times.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("stop_id") not in stop_ids:
                continue
            trip = row.get("trip_id")
            if trip not in trip_service:
                continue
            hour = parse_hour(row.get("arrival_time") or row.get("departure_time") or "")
            if hour is None or not (8 <= hour < 9):
                continue
            counts[row["stop_id"]].add(trip)
            lines[row["stop_id"]].add(routes.get(trip_route.get(trip), ""))
    if not counts:
        return None
    stop_id, trips = max(counts.items(), key=lambda item: len(item[1]))
    buses = len(trips)
    name = next(item[1] for item in near_stops if item[0] == stop_id)
    return {
        "per_hour": buses,
        "stop": name,
        "lines": sorted(line for line in lines[stop_id] if line),
    }


def parse_hour(value):
    parts = value.split(":")
    if len(parts) < 2:
        return None
    try:
        return int(parts[0]) + int(parts[1]) / 60
    except ValueError:
        return None


def main():
    network, pieces = load_network()
    elements = fetch_osm()
    signals = []
    osm_stops = []
    cycle_points = []
    for element in elements:
        tags = element.get("tags") or {}
        if element["type"] == "node" and tags.get("highway") == "traffic_signals":
            hit = nearest_piece(pieces, element["lon"], element["lat"], 45)
            if hit:
                signals.append({"piece": hit[1], "s": round(hit[2], 1), "cycle": 90, "green": 40})
        elif element["type"] == "node" and tags.get("highway") == "bus_stop":
            hit = nearest_piece(pieces, element["lon"], element["lat"], 50)
            if hit:
                osm_stops.append({"piece": hit[1], "s": round(hit[2], 1)})
        elif element["type"] == "way":
            for point in element.get("geometry") or []:
                cycle_points.append((point["lon"], point["lat"]))
    signals = dedupe(signals, 35)
    osm_stops = dedupe(osm_stops, 40)
    print("signals", len(signals), "cycle points", len(cycle_points), "osm stops", len(osm_stops))

    protected = {}
    for name, points in pieces.items():
        if not cycle_points:
            protected[name] = False
            continue
        close = 0
        sample = points[::3] or points
        for lon, lat, _s in sample:
            if min(hav((lon, lat), other) for other in nearby(cycle_points, lon, lat)) < 28:
                close += 1
        protected[name] = close / len(sample) > 0.35
    print("protected", protected)

    loops = fetch_loops()
    keywords = ("emilia", "saffi", "san felice", "stalingrado", "san donato", "pietramellara", "ercolani", "marconi", "amendola")
    matched = [row for row in loops if any(word in row[0].lower() for word in keywords)]
    pool = matched or loops
    by_direction = defaultdict(list)
    for name, direction, peak, _date in pool:
        if 400 <= peak <= 4500:
            by_direction[(name, direction)].append(peak)
    by_site = defaultdict(list)
    for (name, direction), values in by_direction.items():
        by_site[name].append((median(sorted(values)), direction))
    chosen = []
    for name, directions in by_site.items():
        peak, direction = max(directions)
        chosen.append((name, direction, peak))
    car_per_hour = int(round(median(sorted(item[2] for item in chosen)))) if chosen else 2000
    car_per_hour = max(800, min(3500, car_per_hour))
    sites = [f"{name} {direction} {peak:.0f}" for name, direction, peak in sorted(chosen)]
    print("car/h", car_per_hour, sites)

    bikes = fetch_bikes()
    by_counter = defaultdict(lambda: {"bikes": 0.0, "hours": 0, "lon": None, "lat": None, "in": 0.0, "out": 0.0})
    for row in bikes:
        point = row.get("geo_point_2d") or {}
        item = by_counter[row.get("colonnina") or "unknown"]
        item["bikes"] += float(row.get("totale") or 0)
        item["in"] += float(row.get("direzione_centro") or 0)
        item["out"] += float(row.get("direzione_periferia") or 0)
        item["hours"] += 1
        item["lon"] = point.get("lon", item["lon"])
        item["lat"] = point.get("lat", item["lat"])
    route_points = [(lon, lat) for points in pieces.values() for lon, lat, _s in points[::4]]
    bike_choice = None
    for name, item in by_counter.items():
        if not item["hours"] or item["lon"] is None:
            continue
        dist = min(hav((item["lon"], item["lat"]), point) for point in route_points)
        per_hour = max(item["in"], item["out"]) / item["hours"]
        if bike_choice is None or dist < bike_choice[0]:
            bike_choice = (dist, name, per_hour, item["hours"])
    bike_per_hour = int(round(bike_choice[2])) if bike_choice else 120
    print("bike", bike_choice)

    gtfs = fetch_gtfs()
    bus = buses_from_gtfs(gtfs, pieces) if gtfs else None
    if bus:
        bus_per_hour = bus["per_hour"]
        bus_note = f"TPER GTFS, Wednesday 23 Sep 2026, 08:00–09:00 at {bus['stop']}"
        bus_lines = bus["lines"][:12]
    else:
        bus_per_hour = 12
        bus_note = "GTFS count unavailable; 12 buses/hour is a fallback"
        bus_lines = []
    print("buses/h", bus_per_hour, bus_lines[:8])

    supply = {
        "carPerHour": car_per_hour,
        "bikePerHour": bike_per_hour,
        "busPerHour": bus_per_hour,
        "busLines": bus_lines,
        "occupancy": 1.3,
        "passengersPerBus": 45,
        "signals": signals,
        "busStops": osm_stops,
        "bikeProtected": protected,
        "signalTiming": "OSM gives the junction, not the timing. Each signal is modelled as a 90 second cycle with 40 seconds of green for the corridor.",
        "notes": {
            "cars": (
                "The boulevard counters do not sit on Via Emilia. Weekday 08:00–09:00 peak direction on "
                + ", ".join(sites)
                + f". The corridor uses their median, {car_per_hour} veh/h. Source: Comune di Bologna, traffico-viali."
            ),
            "bikes": (
                f"Counter {bike_choice[1]} on 23 Sep 2026, 08:00–09:00 local, peak direction {bike_per_hour} bikes/h, {bike_choice[0]:.0f} m from the corridor."
                if bike_choice else "No bicycle counter returned for that morning."
            ),
            "buses": bus_note + (f". Lines: {', '.join(bus_lines)}." if bus_lines else "."),
            "signals": f"{len(signals)} OSM traffic signals snapped onto the car routes. {signal_phrase(protected)}",
        },
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(supply))
    print("wrote", OUT)


def signal_phrase(protected):
    names = [name for name, flag in protected.items() if flag]
    if not names:
        return "No piece has a cycle track along most of its length, so bikes share the traffic."
    return "Cycle tracks cover most of: " + ", ".join(names) + "."


def dedupe(items, gap):
    kept = []
    for item in sorted(items, key=lambda row: (row["piece"], row["s"])):
        if kept and kept[-1]["piece"] == item["piece"] and item["s"] - kept[-1]["s"] < gap:
            continue
        kept.append(item)
    return kept


def nearby(points, lon, lat):
    lat0 = lat
    chosen = [point for point in points if abs(point[1] - lat0) < 0.004 and abs(point[0] - lon) < 0.006]
    return chosen or points[:1]


def median(values):
    mid = len(values) // 2
    if len(values) % 2:
        return values[mid]
    return 0.5 * (values[mid - 1] + values[mid])


if __name__ == "__main__":
    main()
