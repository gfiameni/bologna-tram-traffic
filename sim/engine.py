"""Shared scenario accounting for every model."""

from dataclasses import dataclass

from sim.design import capacity, junction_count, part_layouts, parts, signal_plan, tram_red_seconds


@dataclass
class Result:
    car_fiera: float
    car_pilastro: float
    bike_fiera: float
    transit_fiera: float
    transit_pilastro: float
    via_emilia: float
    people: float
    unserved: float
    speeds: dict
    bike_speeds: dict
    car_flow: float
    bike_flow: float
    transit: str
    vehicles_per_hour: float


def hour_row(corridor, hour):
    table = {int(item["hour"]): item for item in corridor.hours}
    if int(hour) in table:
        return table[int(hour)]
    return {
        "hour": 8,
        "cars": corridor.car_per_hour,
        "buses": corridor.bus_per_hour,
        "bikes": corridor.bike_per_hour,
    }


def demand(corridor, scenario, shift, hour=8):
    base = hour_row(corridor, hour)
    moved = shift if scenario == "after" else 0.0
    cars = base["cars"] * (1.0 - moved)
    buses = 0.0 if scenario == "after" else base["buses"]
    return cars, buses, base["bikes"]


def buses_left(corridor, hour=8):
    """Buses an hour that keep running where there are no tracks."""
    return hour_row(corridor, hour)["buses"]


def run_piece(piece, scenario, street, priority, headway, car_h, bus_h, bike_h, bus_free, solve, chain_bikes=False):
    """A model's street, stretch by stretch: the cars that leave one stretch enter the next.

    `solve(part, cars, buses, bikes, layout, plan)` is the model on one stretch. Stretches
    without tracks keep `bus_free` buses in After.
    """
    items = parts(piece, scenario)
    layouts = part_layouts([item for _start, _end, item in items], scenario, street)
    rows = []
    car, bike = car_h, bike_h
    for (start, end, item), layout in zip(items, layouts):
        plan = signal_plan(item, scenario, street, priority, headway)
        tracks = scenario == "after" and item.affected
        buses = bus_h if tracks or scenario != "after" else bus_free
        stats = solve(item, car, buses, bike, layout, plan)
        rows.append((start, end, item, layout, plan, tracks, buses, stats))
        car = stats["car_out"]
        if chain_bikes:
            bike = min(bike, max(stats["bike_out"], 1.0))
    loads = [row[7]["pce_in"] / max(1.0, capacity(row[3], row[4])) for row in rows]
    binding = loads.index(max(loads))
    each = [row[7] for row in rows]
    if len(rows) == 1:
        total = dict(each[0])
    else:
        total = {
            "car_min": sum(item["car_min"] for item in each),
            "bus_min": sum(item["bus_min"] for item in each),
            "bike_min": sum(item["bike_min"] for item in each),
            "car_in": car_h,
            "pce_in": each[binding]["pce_in"],
            "car_out": each[-1]["car_out"],
            "bike_out": each[-1]["bike_out"],
        }
        total["car_mps"] = piece.length / (total["car_min"] * 60.0)
        total["bike_mps"] = piece.length / (total["bike_min"] * 60.0)
    total["layout"] = rows[binding][3]
    total["plan"] = rows[binding][4]
    total["capacity"] = capacity(rows[binding][3], rows[binding][4])
    total["parts"] = [
        {
            "from": start,
            "to": end,
            "tram": tracks,
            "lanes": layout["lanes"],
            "carGreen": plan["carGreen"],
            "capacity": capacity(layout, plan),
            "carIn": stats["car_in"],
            "pceIn": stats["pce_in"],
            "carOut": stats["car_out"],
            "carMin": stats["car_min"],
            "freeMin": item.length / item.free / 60,
            "busMin": stats["bus_min"],
            "buses": 0.0 if item.name == "bypass" else buses,
            "junctions": junction_count(item.signals),
        }
        for start, end, item, layout, plan, tracks, buses, stats in rows
    ]
    return total


def chain_time(stats, branch, key):
    return stats["trunk"][key] + stats["bypass"][key] + stats["city"][key] + stats[branch][key]


def bike_trip(stats, branch, key, corridor):
    centre = corridor.centre_m / max(1.0, stats["trunk"]["bike_mps"]) / 60
    return stats["trunk"][key] + centre + stats["city"][key] + stats[branch][key]


def bus_trip(stats, branch, corridor):
    centre = corridor.centre_m / 6.2 / 60
    return stats["trunk"]["bus_min"] + centre + stats["city"]["bus_min"] + stats[branch]["bus_min"]


def tram_minutes(corridor, branch):
    length = corridor.tram_length["trunk"] + corridor.tram_length[branch]
    stops = max(0, corridor.tram_stops.get("trunk", 1) + corridor.tram_stops.get(branch, 1) - 2)
    return (length / 7.6 + stops * 26) / 60


def tram_trip(corridor, branch, design, headway, stats):
    """Timetable minutes, plus the wait at red lights when trams have no priority.

    Where the tracks end before the street does, riders wait half the bus interval and ride on.
    """
    minutes = tram_minutes(corridor, branch) + tram_red_seconds(corridor, branch, design, headway) / 60
    tail = stats[branch]["parts"][-1]
    if not tail["tram"]:
        minutes += 30.0 / max(1.0, tail["buses"]) + tail["busMin"]
    return minutes


def piece_report(corridor, stats):
    """Each street at its busiest stretch, with every stretch listed."""
    report = {}
    for name, item in stats.items():
        piece = corridor.piece(name)
        layout, plan = item["layout"], item["plan"]
        report[name] = {
            "lanes": layout["lanes"],
            "oneWay": layout["oneWay"],
            "forcedOneWay": layout["forced"],
            "cycle": plan["cycle"],
            "green": plan["green"],
            "carGreen": plan["carGreen"],
            "wave": plan["wave"],
            "carIn": item["car_in"],
            "pceIn": item["pce_in"],
            "carOut": item["car_out"],
            "capacity": item["capacity"],
            "carMin": item["car_min"],
            "freeMin": piece.length / piece.free / 60,
            "busMin": item["bus_min"],
            "bikeMin": item["bike_min"],
            "junctions": junction_count(piece.signals),
            "lengthM": piece.length,
            "stretches": item["parts"],
        }
    return report


def pack(result):
    return {
        "carFieraMin": result.car_fiera,
        "carPilastroMin": result.car_pilastro,
        "bikeFieraMin": result.bike_fiera,
        "transitFieraMin": result.transit_fiera,
        "transitPilastroMin": result.transit_pilastro,
        "viaEmiliaKmh": result.via_emilia,
        "peoplePerHour": result.people,
        "unserved": result.unserved,
        "speeds": result.speeds,
        "bikeSpeeds": result.bike_speeds,
        "carFlow": result.car_flow,
        "bikeFlow": result.bike_flow,
        "transit": result.transit,
        "vehiclesPerHour": result.vehicles_per_hour,
    }


def people_and_transit(corridor, scenario, shift, headway, trunk_cars, trunk_bikes, transit_fiera, transit_pilastro, speeds, bike_speeds, car_fiera, car_pilastro, bike_fiera, hour=8):
    base = hour_row(corridor, hour)
    if scenario == "after":
        market = base["buses"] * corridor.passengers_per_bus + base["cars"] * shift * corridor.occupancy
        capacity = (60.0 / headway) * 220.0
        transit = "tram"
        vehicles = 60.0 / headway
    else:
        market = base["buses"] * corridor.passengers_per_bus
        capacity = base["buses"] * 90.0
        transit = "bus"
        vehicles = base["buses"]
    carried = min(market, capacity)
    return pack(Result(
        car_fiera=car_fiera,
        car_pilastro=car_pilastro,
        bike_fiera=bike_fiera,
        transit_fiera=transit_fiera,
        transit_pilastro=transit_pilastro,
        via_emilia=speeds["trunk"] * 3.6,
        people=trunk_cars * corridor.occupancy + trunk_bikes + carried,
        unserved=max(0.0, market - capacity),
        speeds=speeds,
        bike_speeds=bike_speeds,
        car_flow=trunk_cars,
        bike_flow=trunk_bikes,
        transit=transit,
        vehicles_per_hour=vehicles,
    ))
