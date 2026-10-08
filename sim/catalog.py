"""Write what the browser needs to run the models, and Python reference runs for the tests.

public/corridor.json holds the streets, signals, stops, hourly demand, and the
surrogate weights. test/fixtures/reference.json holds Python runs of every model
for a few street designs. The browser ports must match them.
"""

import copy
import json

from sim.design import default_design
from sim.device import describe
from sim.models import MODELS, run
from sim.supply import ROOT, load
from sim.surrogate import save, train


def designs():
    today = default_design()
    no_priority = copy.deepcopy(today)
    no_priority["priority"] = False
    one_way = copy.deepcopy(today)
    for name in ("trunk", "city"):
        one_way["streets"][name]["oneWay"] = True
    lights = copy.deepcopy(today)
    for street in lights["streets"].values():
        street.update(cycle=120, green=75, wave=True)
    narrow = copy.deepcopy(today)
    narrow["streets"]["trunk"]["width"] = 11.0
    narrow["streets"]["bypass"]["width"] = 16.0
    return {"today": today, "no-priority": no_priority, "one-way": one_way, "lights": lights, "narrow": narrow}


def reference(corridor):
    cases = []
    for design_id, design in designs().items():
        for name in MODELS:
            for hour in (8, 21):
                settings = [(0.25, 4.5)]
                if design_id == "today":
                    settings += [(0.0, 4.5), (0.25, 3.0)]
                for shift, headway in settings:
                    cases.append({
                        "model": name,
                        "design": design_id,
                        "hour": hour,
                        "shift": shift,
                        "headway": headway,
                        "before": run(name, corridor, "before", shift, headway, hour=hour, design=design),
                        "after": run(name, corridor, "after", shift, headway, hour=hour, design=design),
                    })
    return {"designs": designs(), "cases": cases}


def browser_inputs(corridor, weights):
    return {
        "models": [
            {"id": "ctm", "label": "Cell transmission"},
            {"id": "bpr", "label": "Volume-delay"},
            {"id": "idm", "label": "Car following"},
            {"id": "surrogate", "label": "Neural surrogate"},
        ],
        "defaultModel": "ctm",
        "defaultHour": 8,
        "hours": corridor.hours,
        "device": describe(),
        "pieces": {
            name: {
                "length": piece.length,
                "affected": piece.affected,
                "free": piece.free,
                "signals": piece.signals,
                "stops": piece.stops,
                "bikeProtected": piece.bike_protected,
            }
            for name, piece in corridor.pieces.items()
        },
        "tramLength": corridor.tram_length,
        "tramStops": corridor.tram_stops,
        "centreM": corridor.centre_m,
        "supply": {
            "carPerHour": corridor.car_per_hour,
            "bikePerHour": corridor.bike_per_hour,
            "busPerHour": corridor.bus_per_hour,
            "busLines": corridor.bus_lines,
            "occupancy": corridor.occupancy,
            "passengersPerBus": corridor.passengers_per_bus,
            "notes": corridor.notes,
            "signalTiming": corridor.signal_timing,
        },
        "surrogate": {
            "weights": weights,
            "holdoutMinutesMae": weights["holdoutMinutesMae"],
            "samples": weights["samples"],
            "note": "A 16-neuron network trained on cell-transmission runs of this corridor, across lanes and signal plans. The holdout error is in minutes, per street.",
        },
    }


def build(root=ROOT):
    corridor = load(root)
    weights = train(corridor)
    save(weights, root / "data" / "surrogate.json")
    inputs = browser_inputs(corridor, weights)
    (root / "public" / "corridor.json").write_text(json.dumps(inputs))
    fixtures = root / "test" / "fixtures"
    fixtures.mkdir(parents=True, exist_ok=True)
    runs = reference(corridor)
    (fixtures / "reference.json").write_text(json.dumps(runs))
    print("wrote public/corridor.json and test/fixtures/reference.json with", len(runs["cases"]), "cases")
    print("surrogate holdout", weights["holdoutMinutesMae"], "min over", weights["samples"], "runs")
    return inputs


if __name__ == "__main__":
    build()
