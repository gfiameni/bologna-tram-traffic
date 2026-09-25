import json
from dataclasses import dataclass, field
from pathlib import Path

from sim.geometry import polyline_length

PIECES = ("trunk", "bypass", "city", "fiera", "pilastro")
FREE_MPS = {"trunk": 13.2, "bypass": 12.4, "city": 11.2, "fiera": 12.6, "pilastro": 12.0}
ROOT = Path(__file__).resolve().parents[1]


@dataclass
class Piece:
    name: str
    length: float
    affected: bool
    free: float
    signals: list = field(default_factory=list)
    stops: list = field(default_factory=list)
    bike_protected: bool = False


@dataclass
class Corridor:
    pieces: dict
    tram_length: dict
    tram_stops: dict
    centre_m: float
    car_per_hour: float
    bike_per_hour: float
    bus_per_hour: float
    bus_lines: list
    occupancy: float
    passengers_per_bus: float
    notes: dict
    signal_timing: str
    hours: list = field(default_factory=list)

    def piece(self, name):
        return self.pieces[name]


def load(root=ROOT):
    network = json.loads((root / "public" / "network.json").read_text())
    raw = json.loads((root / "data" / "supply.json").read_text())
    pieces = {}
    for name in PIECES:
        coords = network["pieces"]["car"][name]
        pieces[name] = Piece(
            name=name,
            length=polyline_length(coords),
            affected=bool(network["affected"]["car"][name]),
            free=FREE_MPS[name],
            signals=[item["s"] for item in raw["signals"] if item["piece"] == name and 0 < item["s"]],
            stops=[item["s"] for item in raw["busStops"] if item["piece"] == name and 0 < item["s"]],
            bike_protected=bool(raw["bikeProtected"].get(name)),
        )
    tram_length = {
        name: polyline_length(coords) for name, coords in network["pieces"]["tram"].items()
    }
    tram_stops = {"trunk": 0, "fiera": 0, "pilastro": 0}
    for stop in network["stops"]:
        tram_stops[stop["branch"]] = tram_stops.get(stop["branch"], 0) + 1
    centre = max(0.0, tram_length["trunk"] - network["screenline"]["tramTrunkM"] - pieces["city"].length)
    hours_path = root / "data" / "hours.json"
    if hours_path.exists():
        hours = json.loads(hours_path.read_text())["slots"]
    else:
        hours = [{
            "hour": 8,
            "label": "08:00 · morning peak",
            "cars": raw["carPerHour"],
            "buses": raw["busPerHour"],
            "bikes": raw["bikePerHour"],
        }]
    return Corridor(
        pieces=pieces,
        tram_length=tram_length,
        tram_stops=tram_stops,
        centre_m=centre,
        car_per_hour=raw["carPerHour"],
        bike_per_hour=raw["bikePerHour"],
        bus_per_hour=raw["busPerHour"],
        bus_lines=raw.get("busLines") or [],
        occupancy=raw.get("occupancy", 1.3),
        passengers_per_bus=raw.get("passengersPerBus", 45),
        notes=raw.get("notes") or {},
        signal_timing=raw.get("signalTiming", ""),
        hours=hours,
    )
