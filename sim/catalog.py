"""Precompute the slider grid so the page has every model without a server."""

import json
from pathlib import Path

from sim.device import describe
from sim.engine import hour_row
from sim.models import MODELS, run
from sim.supply import ROOT, load
from sim.surrogate import save, train

SHIFTS = (0.0, 0.15, 0.25, 0.35, 0.5)
HEADWAYS = (3.0, 4.5, 6.0, 8.0)


def case_key(name, scenario, shift, headway, hour):
    return f"{name}|{scenario}|{shift:.2f}|{headway:.1f}|{int(hour):02d}"


def with_headway(result, corridor, scenario, shift, headway, hour):
    copied = json.loads(json.dumps(result))
    if scenario != "after":
        return copied
    base = hour_row(corridor, hour)
    market = base["buses"] * corridor.passengers_per_bus + base["cars"] * shift * corridor.occupancy
    capacity = (60.0 / headway) * 220.0
    carried = min(market, capacity)
    copied["peoplePerHour"] = copied["carFlow"] * corridor.occupancy + copied["bikeFlow"] + carried
    copied["unserved"] = max(0.0, market - capacity)
    copied["vehiclesPerHour"] = 60.0 / headway
    return copied


def build(root=ROOT):
    corridor = load(root)
    weights = train(corridor)
    save(weights, root / "data" / "surrogate.json")
    cases = {}
    hours = [int(item["hour"]) for item in corridor.hours]
    for name in MODELS:
        for hour in hours:
            for scenario in ("before", "after"):
                for shift in SHIFTS:
                    base = run(name, corridor, scenario, shift, 4.5, hour=hour)
                    for headway in HEADWAYS:
                        cases[case_key(name, scenario, shift, headway, hour)] = with_headway(
                            base, corridor, scenario, shift, headway, hour
                        )
    catalog = {
        "models": [
            {"id": "bpr", "label": "Volume-delay"},
            {"id": "ctm", "label": "Cell transmission"},
            {"id": "idm", "label": "Car following"},
            {"id": "surrogate", "label": "Neural surrogate"},
        ],
        "defaultModel": "ctm",
        "shifts": list(SHIFTS),
        "headways": list(HEADWAYS),
        "hours": corridor.hours,
        "defaultHour": 8,
        "device": describe(),
        "surrogate": {
            "holdoutMinutesMae": weights["holdoutMinutesMae"],
            "samples": weights["samples"],
            "note": "A 12-neuron network trained on cell-transmission runs of this corridor. The holdout error is in minutes, per street.",
        },
        "supply": {
            "carPerHour": corridor.car_per_hour,
            "bikePerHour": corridor.bike_per_hour,
            "busPerHour": corridor.bus_per_hour,
            "busLines": corridor.bus_lines,
            "notes": corridor.notes,
            "signalTiming": corridor.signal_timing,
            "centreM": round(corridor.centre_m),
        },
        "cases": cases,
    }
    path = root / "public" / "catalog.json"
    path.write_text(json.dumps(catalog))
    print("wrote", path, "cases", len(cases))
    return catalog


if __name__ == "__main__":
    build()
