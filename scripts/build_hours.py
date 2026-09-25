#!/usr/bin/env python3
"""Hourly car, bus, and bicycle demand for the corridor selector.

Cars come from the weekday boulevard loops already saved in data/raw.
Buses come from the cached TPER GTFS at Porta San Felice.
Bicycles come from the Stalingrado counter on the open-data API.
"""

import csv
import json
import subprocess
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
RAW = ROOT / "data" / "raw"
OUT = ROOT / "data" / "hours.json"
UA = "bologna-tram-traffic/1.0 (educational corridor model)"
STOP_ID = "52"
SERVICE_DAY = "20260923"

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


def car_hours():
    wanted = {("Viale Ercolani", "Sud"), ("Viale Pietramellara", "Nord Est")}
    bins = hour_columns()
    samples = {key: defaultdict(list) for key in wanted}
    with (RAW / "traffico-viali.csv").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle, delimiter=";"):
            key = (row.get("via_spira") or "", row.get("direzione") or "")
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


def weekday_services(gtfs):
    services = set()
    with (gtfs / "calendar.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("wednesday") == "1" and row.get("start_date", "9") <= SERVICE_DAY <= row.get("end_date", "0"):
                services.add(row["service_id"])
    added, removed = set(), set()
    with (gtfs / "calendar_dates.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("date") != SERVICE_DAY:
                continue
            if row.get("exception_type") == "1":
                added.add(row["service_id"])
            elif row.get("exception_type") == "2":
                removed.add(row["service_id"])
    return (services | added) - removed


def bus_hours():
    gtfs = RAW / "gtfs"
    services = weekday_services(gtfs)
    trips = set()
    with (gtfs / "trips.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("service_id") in services:
                trips.add(row["trip_id"])
    counts = defaultdict(set)
    with (gtfs / "stop_times.txt").open(encoding="utf-8-sig", newline="") as handle:
        for row in csv.DictReader(handle):
            if row.get("stop_id") != STOP_ID or row.get("trip_id") not in trips:
                continue
            parts = (row.get("arrival_time") or "").split(":")
            if len(parts) < 2:
                continue
            hour = int(parts[0]) % 24
            counts[hour].add(row["trip_id"])
    return [len(counts[hour]) for hour in range(24)]


def bike_hours():
    url = (
        "https://opendata.comune.bologna.it/api/explore/v2.1/catalog/datasets/colonnine-conta-bici/records"
        "?limit=100&where=colonnina%3D%22Stalingrado_II%22%20AND%20"
        "data%3E%3D%222026-09-22T22%3A00%3A00%22%20AND%20data%3C%222026-09-23T22%3A00%3A00%22"
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


def main():
    cars = car_hours()
    buses = bus_hours()
    bikes = bike_hours()
    print("cars", [cars[hour] for hour, _ in SLOTS])
    print("buses", [buses[hour] for hour, _ in SLOTS])
    print("bikes", [bikes[hour] for hour, _ in SLOTS])
    if cars[8] < 800:
        raise SystemExit("morning car count looks wrong")
    slots = []
    for hour, label in SLOTS:
        slots.append({
            "hour": hour,
            "label": label,
            "cars": cars[hour],
            "buses": buses[hour],
            "bikes": max(bikes[hour], 0),
        })
    OUT.write_text(json.dumps({"sourceDay": "2026-09-23", "slots": slots}))
    print("wrote", OUT)


if __name__ == "__main__":
    main()
