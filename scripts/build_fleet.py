#!/usr/bin/env python3
"""Build public/fleet.json: the bus trips the tram takes off Via Emilia.

The 2024 timetable lists every trip of every line that stops at Porta San Felice. The 2026
service (data/supply.json) has no 19 or 36 there any more. Those lines are the buses the tram
replaces, and their weekday trips are the workload the fleet planner has to cover again.

Needs data/raw/tper-september-2024.csv, which `python3 scripts/fetch_supply.py` downloads.
"""

import csv
import json
import re
import sys
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw" / "tper-september-2024.csv"
SUPPLY = ROOT / "data" / "supply.json"
OUT = ROOT / "public" / "fleet.json"
STOP_NAME = "PORTA SAN FELICE"
DAY = "2024-09-06"


def family(route):
    """19, 19/, 19A, 19B, and 19C are one line family."""
    match = re.match(r"\d+", route or "")
    return match.group(0) if match else route


def minutes(clock):
    """Minutes after midnight. TPER writes times past 24:00 for trips that run past midnight."""
    parts = (clock or "").split(":")
    return int(parts[0]) * 60 + int(parts[1]) + (int(parts[2]) / 60 if len(parts) > 2 else 0)


def unroll(stop_times):
    """The table writes 01:05 for a stop after midnight, not 25:05. Make each time follow the one before."""
    clock = 0.0
    fixed = []
    for seq, route, stop_id, name, lat, lon, arrive, depart in stop_times:
        for _ in range(3):
            if arrive >= clock:
                break
            arrive += 1440
        for _ in range(3):
            if depart >= arrive:
                break
            depart += 1440
        clock = depart
        fixed.append((seq, route, stop_id, name, lat, lon, arrive, depart))
    return fixed


def withdrawn_families():
    supply = json.loads(SUPPLY.read_text())
    before = {family(line) for line in supply["busLines"]}
    after = {family(line) for line in supply["after"]["busLines"]}
    return sorted(before - after, key=int), sorted(after, key=int)


def main():
    if not RAW.exists():
        sys.exit(f"missing {RAW.relative_to(ROOT)}: run scripts/fetch_supply.py first")
    gone, kept = withdrawn_families()
    rows = defaultdict(list)
    with RAW.open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row["date"] != DAY or row["giorno"] != "feriale" or family(row["route_id"]) not in gone:
                continue
            rows[row["trip_id"]].append((
                int(row["stop_sequence"]), row["route_id"], row["stop_id"], row["stop_name"],
                float(row["stop_lat"]), float(row["stop_lon"]), minutes(row["arrival_time"]),
                minutes(row["departure_time"]),
            ))
    stops, stop_index, lines, trips = [], {}, [], []
    ordered = {trip_id: unroll(sorted(stop_times)) for trip_id, stop_times in rows.items()}
    # The buses of a route run both ways, and the way back may stop under another name or on another
    # street. A route is replaced if any of its trips stops at Porta San Felice, and then every trip counts.
    replaced = {
        stop_times[0][1] for stop_times in ordered.values()
        if STOP_NAME in [item[3].upper() for item in stop_times]
    }
    for trip_id, stop_times in ordered.items():
        names = [item[3].upper() for item in stop_times]
        if stop_times[0][1] not in replaced:
            continue
        first, last = stop_times[0], stop_times[-1]
        ends = []
        for item in (first, last):
            key = item[2]
            if key not in stop_index:
                stop_index[key] = len(stops)
                stops.append({"id": key, "name": item[3].title(), "lat": item[4], "lon": item[5]})
            ends.append(stop_index[key])
        route = first[1]
        if route not in lines:
            lines.append(route)
        trips.append({
            "id": trip_id, "line": lines.index(route), "from": ends[0], "to": ends[1],
            "start": round(first[7], 1), "end": round(last[6], 1),
            "psf": round(stop_times[names.index(STOP_NAME)][6], 1) if STOP_NAME in names else None,
        })
    trips.sort(key=lambda trip: (trip["start"], trip["id"]))
    OUT.write_text(json.dumps({
        "source": "Comune di Bologna historical TPER timetable, September 2024 (CC BY 4.0)",
        "day": DAY,
        "withdrawn": gone,
        "kept": kept,
        "lines": lines,
        "stops": stops,
        "trips": trips,
        "note": (
            "Weekday trips, both directions, of the routes that stop at Porta San Felice in 2024 and "
            "whose lines do not in 2026. psf is the minute a trip passes Porta San Felice, or null on the way back. "
            "Times are minutes after midnight. Depots, drivers, layover, and deadhead speed are "
            "assumptions in sim/fleet.py, because TPER does not publish them."
        ),
    }, separators=(",", ":")))
    print(f"withdrawn lines {gone}: {len(trips)} trips, {len(stops)} terminals -> {OUT.relative_to(ROOT)}")


if __name__ == "__main__":
    main()
