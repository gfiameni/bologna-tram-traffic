#!/usr/bin/env python3
"""Hourly car, bus, and bicycle demand for the corridor selector, for Before and After.

Cars come from the weekday boulevard loops already saved in data/raw, 2024 for Before and
2026 for After. Buses come from TPER at Porta San Felice: the Comune's historical table for
Friday 6 September 2024, and the published GTFS for Friday 11 September 2026. Bicycles come
from the San Donato counter, the nearest to the corridor, on the same two days.
"""

import csv
import json
import subprocess
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "hours.json"
UA = "bologna-tram-traffic/1.0 (educational corridor model)"
STOP_ID = "52"
COUNTER = "San Donato"
YEARS = {
    "before": {"year": "2024", "day": "2024-09-06"},
    "after": {"year": "2026", "day": "2026-09-11"},
}

SLOTS = (
    (6, "06:00 · early morning"),
    (7, "07:00 · building up"),
    (8, "08:00 · morning peak"),
    (9, "09:00 · late peak"),
    (12, "12:00 · midday"),
    (15, "15:00 · afternoon"),
    (17, "17:00 · evening build-up"),
    (18, "18:00 · evening peak"),
    (21, "21:00 · evening"),
)


def median(values):
    values = sorted(values)
    if not values:
        return 0
    mid = len(values) // 2
    if len(values) % 2:
        return values[mid]
    return 0.5 * (values[mid - 1] + values[mid])


def hour_columns():
    names = []
    for hour in range(24):
        start = f"{hour}_00_{hour}_30"
        end_hour = hour + 1
        end = "23_30_24_00" if hour == 23 else f"{hour}_30_{end_hour}_00"
        names.append((start, end))
    return names


def car_hours(year):
    wanted = {("Viale Ercolani", "Sud"), ("Viale Pietramellara", "Nord Est")}
    bins = hour_columns()
    samples = {key: defaultdict(list) for key in wanted}
    with (RAW / "traffico-viali.csv").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle, delimiter=";"):
            key = (row.get("via_spira") or "", row.get("direzione") or "")
            if not (row.get("data") or "").startswith(f"{year}-"):
                continue
            if key not in wanted or "feriale" not in (row.get("tipo_giorno") or ""):
                continue
            for hour, (left, right) in enumerate(bins):
                try:
                    total = float(row[left]) + float(row[right])
                except (KeyError, TypeError, ValueError):
                    continue
                if 0 <= total <= 4500:
                    samples[key][hour].append(total)
    hours = []
    for hour in range(24):
        site = [median(samples[key][hour]) for key in wanted if samples[key][hour]]
        hours.append(int(round(median(site))) if site else 0)
    return hours


def count_hours(rows):
    counts = defaultdict(set)
    for trip, clock in rows:
        parts = clock.split(":")
        if len(parts) < 2:
            continue
        counts[int(parts[0]) % 24].add(trip)
    return [len(counts[hour]) for hour in range(24)]


def tper_bus_hours(day):
    rows = []
    with (RAW / "tper-september-2024.csv").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("date") != day or row.get("giorno") != "feriale":
                continue
            if row.get("stop_id") != STOP_ID or (row.get("stop_name") or "").upper() != "PORTA SAN FELICE":
                continue
            rows.append((row["trip_id"], row.get("arrival_time") or ""))
    return count_hours(rows)


def gtfs_services(gtfs, day):
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
    return services


def gtfs_bus_hours(day):
    gtfs = RAW / "gtfs"
    services = gtfs_services(gtfs, day)
    with (gtfs / "trips.txt").open(encoding="utf-8-sig", newline="") as handle:
        trips = {row["trip_id"] for row in csv.DictReader(handle) if row.get("service_id") in services}
    rows = []
    with (gtfs / "stop_times.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("stop_id") == STOP_ID and row.get("trip_id") in trips:
                rows.append((row["trip_id"], row.get("arrival_time") or ""))
    return count_hours(rows)


def bike_hours(day):
    start = date.fromisoformat(day).toordinal()
    first = date.fromordinal(start - 1).isoformat()
    url = (
        "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/colonnine-conta-bici/records"
        f"?limit=100&where=colonnina%3D%22{COUNTER.replace(' ', '%20')}%22%20AND%20"
        f"data%3E%3D%22{first}T22%3A00%3A00%22%20AND%20data%3C%22{day}T22%3A00%3A00%22"
    )
    payload = json.loads(subprocess.check_output(["curl", "-sS", "-L", "-A", UA, "--max-time", "40", url]))
    hours = [0] * 24
    for row in payload.get("results") or []:
        stamp = row.get("data") or ""
        clock = stamp[11:13]
        if not clock.isdigit():
            continue
        local = (int(clock) + 2) % 24
        flow = max(float(row.get("direzione_centro") or 0), float(row.get("direzione_periferia") or 0))
        hours[local] = int(round(flow))
    return hours


def year_slots(key):
    year, day = YEARS[key]["year"], YEARS[key]["day"]
    cars = car_hours(year)
    buses = tper_bus_hours(day) if key == "before" else gtfs_bus_hours(day)
    bikes = bike_hours(day)
    print(year, "cars", [cars[hour] for hour, _ in SLOTS])
    print(year, "buses", [buses[hour] for hour, _ in SLOTS])
    print(year, "bikes", [bikes[hour] for hour, _ in SLOTS])
    if cars[8] < 800:
        raise SystemExit(f"{year} morning car count looks wrong")
    slots = [{"hour": hour, "label": label, "cars": cars[hour], "buses": buses[hour], "bikes": max(bikes[hour], 0)}
             for hour, label in SLOTS]
    return {"year": int(year), "sourceDay": day, "slots": slots}


def main():
    before = year_slots("before")
    after = year_slots("after")
    OUT.write_text(json.dumps({**before, "after": after}))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
