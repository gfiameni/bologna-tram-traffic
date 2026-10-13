#!/usr/bin/env python3
"""Download open data and attach it to the Linea Rossa corridor.

Sources, all public:
- OpenStreetMap traffic signals, cycleways, and bus stops
- Comune di Bologna loop detectors (traffico-viali)
- Comune di Bologna bicycle counters (colonnine-conta-bici)
- TPER timetables: the Comune's September 2024 historical table and the September 2026 GTFS

Before uses 2024 and After uses 2026. Both years count the same Friday in the same
week of September, at the same bicycle counter.
"""

import csv
import json
import math
import subprocess
import zipfile
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "supply.json"
UA = "bologna-tram-traffic/1.0 (educational corridor model)"
SCREEN = (11.32803, 44.49898)
YEARS = {
    "before": {"year": "2024", "day": "2024-09-06"},
    "after": {"year": "2026", "day": "2026-09-11"},
}
SERVICE_FILE_ID = "18m9zqbXD0ao6BY8-5mOPQefOfoKrX9k8"
GTFS_VERSION = "20260909"
STOP_NAME = "PORTA SAN FELICE"


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


def fetch_loops(year):
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
            if not (row.get("data") or "").startswith(f"{year}-"):
                continue
            if "feriale" not in (row.get("tipo_giorno") or ""):
                continue
            try:
                peak = float(row["8_00_8_30"]) + float(row["8_30_9_00"])
            except (KeyError, TypeError, ValueError):
                continue
            rows.append((row.get("via_spira") or "", row.get("direzione") or "", peak, row.get("data") or ""))
    return rows


def fetch_bikes(day):
    # 06:00–07:00 UTC is 08:00–09:00 in Bologna in September.
    url = (
        "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/colonnine-conta-bici/records"
        "?limit=100&offset={offset}&where="
        + f"data%3E%3D%22{day}T06:00:00%22%20AND%20data%3C%22{day}T07:00:00%22"
    )
    records = []
    for offset in range(0, 800, 100):
        payload = json.loads(curl(url.format(offset=offset)))
        batch = payload.get("results") or []
        records.extend(batch)
        if len(batch) < 100:
            break
    print("bike records", day, len(records))
    return records


def fetch_tper():
    """Official Comune di Bologna historical TPER table for September 2024."""
    path = RAW / "tper-september-2024.csv"
    if path.exists() and path.stat().st_size > 1_000_000:
        print("cached", path.name)
        return path
    url = (
        "https://drive.usercontent.google.com/download"
        f"?id={SERVICE_FILE_ID}&export=download&confirm=t"
    )
    curl(url, path)
    print("TPER bytes", path.stat().st_size)
    return path


def fetch_gtfs():
    """TPER's published GTFS for September 2026."""
    dest = RAW / "gtfs"
    if (dest / "stop_times.txt").exists():
        print("cached gtfs")
        return dest
    path = RAW / "gommagtfsbo.zip"
    if not (path.exists() and zipfile.is_zipfile(path)):
        url = (
            "https://solweb.tper.it/web/tools/open-data/open-data-download.aspx"
            f"?source=solweb.tper.it&filename=gommagtfsbo&version={GTFS_VERSION}&format=zip"
        )
        curl(url, path)
    if not zipfile.is_zipfile(path):
        raise SystemExit("the TPER GTFS download was not a zip")
    with zipfile.ZipFile(path) as archive:
        archive.extractall(dest)
    return dest


def busiest_stop(rows):
    """Trips 08:00–09:00 at the Porta San Felice stop with the most of them, and their lines."""
    counts = defaultdict(set)
    lines = defaultdict(set)
    for stop_id, trip, route, clock in rows:
        hour = parse_hour(clock)
        if hour is None or not (8 <= hour < 9):
            continue
        counts[stop_id].add(trip)
        lines[stop_id].add(route)
    if not counts:
        return None
    stop_id, trips = max(counts.items(), key=lambda item: len(item[1]))
    return {
        "per_hour": len(trips),
        "stop": "Porta San Felice",
        "lines": sorted(line for line in lines[stop_id] if line),
    }


def buses_from_tper(path, day):
    rows = []
    with path.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("date") != day or row.get("giorno") != "feriale":
                continue
            if (row.get("stop_name") or "").upper() != STOP_NAME:
                continue
            rows.append((row["stop_id"], row.get("trip_id"), row.get("route_id") or "",
                         row.get("arrival_time") or row.get("departure_time") or ""))
    return busiest_stop(rows)


def gtfs_trips(gtfs, day):
    """Trip id to route id, for every trip that runs on the day."""
    key = day.replace("-", "")
    weekday = date.fromisoformat(day).strftime("%A").lower()
    services = set()
    with (gtfs / "calendar.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get(weekday) == "1" and row.get("start_date", "9") <= key <= row.get("end_date", "0"):
                services.add(row["service_id"])
    with (gtfs / "calendar_dates.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("date") != key:
                continue
            if row.get("exception_type") == "1":
                services.add(row["service_id"])
            elif row.get("exception_type") == "2":
                services.discard(row["service_id"])
    trips = {}
    with (gtfs / "trips.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("service_id") in services:
                trips[row["trip_id"]] = row.get("route_id") or ""
    return trips


def gtfs_stop_ids(gtfs):
    with (gtfs / "stops.txt").open(encoding="utf-8-sig", newline="") as handle:
        return {row["stop_id"] for row in csv.DictReader(handle) if (row.get("stop_name") or "").upper() == STOP_NAME}


def buses_from_gtfs(gtfs, day):
    trips = gtfs_trips(gtfs, day)
    stops = gtfs_stop_ids(gtfs)
    rows = []
    with (gtfs / "stop_times.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("stop_id") in stops and row.get("trip_id") in trips:
                rows.append((row["stop_id"], row["trip_id"], trips[row["trip_id"]],
                             row.get("arrival_time") or row.get("departure_time") or ""))
    return busiest_stop(rows)


def day_label(day):
    return date.fromisoformat(day).strftime("%A %-d %b %Y")


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
                signals.append({"piece": hit[1], "s": round(hit[2], 1), "cycle": 90, "green": 50})
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

    before = year_demand("before", pieces)
    after = year_demand("after", pieces, counter=before.pop("counter"))
    after.pop("counter")
    supply = {
        **before,
        "occupancy": 1.3,
        "passengersPerBus": 45,
        "signals": signals,
        "busStops": osm_stops,
        "bikeProtected": protected,
        "signalTiming": "OSM gives the junction, not the timing. The baseline lights are modelled as a 90 second cycle with 50 seconds of green for the corridor, which lets these streets carry the counted cars. Lights closer than 60 m are one junction.",
        "after": after,
    }
    supply["notes"]["signals"] = f"{len(signals)} OSM traffic signals snapped onto the car routes. {signal_phrase(protected)}"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(supply))
    print("wrote", OUT)


def car_sites(year):
    loops = fetch_loops(year)
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
    return chosen


def bike_counter(records, pieces, counter=None):
    """The counter nearest the corridor, or the named one, and its peak-direction flow."""
    by_counter = defaultdict(lambda: {"hours": 0, "lon": None, "lat": None, "in": 0.0, "out": 0.0})
    for row in records:
        point = row.get("geo_point_2d") or {}
        item = by_counter[row.get("colonnina") or "unknown"]
        item["in"] += float(row.get("direzione_centro") or 0)
        item["out"] += float(row.get("direzione_periferia") or 0)
        item["hours"] += 1
        item["lon"] = point.get("lon", item["lon"])
        item["lat"] = point.get("lat", item["lat"])
    route_points = [(lon, lat) for points in pieces.values() for lon, lat, _s in points[::4]]
    choice = None
    for name, item in by_counter.items():
        if not item["hours"] or item["lon"] is None or (counter and name != counter):
            continue
        dist = min(hav((item["lon"], item["lat"]), point) for point in route_points)
        per_hour = max(item["in"], item["out"]) / item["hours"]
        if choice is None or dist < choice[0]:
            choice = (dist, name, per_hour)
    return choice


def year_demand(key, pieces, counter=None):
    """Morning-peak cars, buses, and bicycles on the corridor for Before or After."""
    year, day = YEARS[key]["year"], YEARS[key]["day"]
    chosen = car_sites(year)
    car_per_hour = int(round(median(sorted(item[2] for item in chosen)))) if chosen else 2000
    car_per_hour = max(800, min(3500, car_per_hour))
    sites = [f"{name} {direction} {peak:.0f}" for name, direction, peak in sorted(chosen)]
    print(year, "car/h", car_per_hour, sites)

    bike = bike_counter(fetch_bikes(day), pieces, counter)
    if bike is None:
        raise SystemExit(f"no bicycle count on {day}" + (f" at {counter}" if counter else ""))
    bike_per_hour = int(round(bike[2]))
    print(year, "bike", bike)

    if key == "before":
        bus = buses_from_tper(fetch_tper(), day)
        source = "TPER historical timetable"
    else:
        bus = buses_from_gtfs(fetch_gtfs(), day)
        source = "TPER GTFS timetable"
    if not bus:
        raise SystemExit(f"no TPER trips at Porta San Felice on {day}")
    bus_lines = bus["lines"][:12]
    print(year, "buses/h", bus["per_hour"], bus_lines)

    return {
        "year": int(year),
        "day": day,
        "carPerHour": car_per_hour,
        "bikePerHour": bike_per_hour,
        "busPerHour": bus["per_hour"],
        "busLines": bus_lines,
        "counter": bike[1],
        "notes": {
            "cars": (
                f"The boulevard counters do not sit on Via Emilia. Weekdays of {year}, 08:00–09:00 peak direction on "
                + ", ".join(sites)
                + f". The corridor uses their median, {car_per_hour} veh/h. Source: Comune di Bologna, traffico-viali."
            ),
            "bikes": (
                f"Counter {bike[1]} on {day_label(day)}, 08:00–09:00 local, peak direction {bike_per_hour} bikes/h, "
                f"{bike[0]:.0f} m from the corridor."
            ),
            "buses": f"{source}, {day_label(day)}, 08:00–09:00 at {bus['stop']}. Lines: {', '.join(bus_lines)}.",
        },
    }


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
