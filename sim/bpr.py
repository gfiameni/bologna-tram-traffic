"""Volume-delay model with signals, buses, and bicycles."""

from sim.design import SATURATION_PER_LANE, WAVE_PROGRESSION, junction_count
from sim.engine import bike_trip, buses_left, bus_trip, chain_time, demand, people_and_transit, piece_report, run_piece, tram_trip

ALPHA = 0.8


def _speed(flow, capacity, free):
    ratio = flow / max(1.0, capacity)
    return free / (1.0 + ALPHA * ratio * ratio)


def _signal_delay(flow, lanes, signals, plan):
    cycle = plan["cycle"]
    green = plan["carGreen"] / cycle
    saturation = max(1.0, lanes * SATURATION_PER_LANE)
    progression = WAVE_PROGRESSION if plan["wave"] else 1.0
    volume = min(0.92, flow / (saturation * green))
    each = 0.5 * cycle * (1 - green) ** 2 / max(0.08, 1 - green * volume)
    return progression * each * junction_count(signals)


def _piece(piece, car_h, bus_h, bike_h, layout, plan):
    lanes = layout["lanes"]
    bus = bus_h if piece.name != "bypass" else 0.0
    if piece.bike_protected:
        pce = car_h + 2.2 * bus
        bike_mps = 5.6
    else:
        pce = car_h + 2.2 * bus + 0.3 * bike_h
        bike_mps = None
    capacity = lanes * SATURATION_PER_LANE * plan["carGreen"] / plan["cycle"]
    car_mps = _speed(pce, capacity, piece.free)
    if bike_mps is None:
        bike_mps = min(4.6, car_mps * 0.9)
    delay = _signal_delay(pce, lanes, piece.signals, plan)
    car_min = (piece.length / car_mps + delay) / 60
    bus_min = (piece.length / min(car_mps, 11.0) + delay + 20 * len(piece.stops)) / 60
    bike_min = (piece.length / bike_mps) / 60
    # The curve assigns the whole demand and spends the delay in travel time.
    return {
        "car_min": car_min,
        "bus_min": bus_min,
        "bike_min": bike_min,
        "car_mps": car_mps,
        "bike_mps": bike_mps,
        "car_in": car_h,
        "pce_in": pce,
        "car_out": car_h,
        "bike_out": bike_h,
    }


def run(corridor, scenario, shift, headway, hour=8, design=None):
    car_h, bus_h, bike_h = demand(corridor, scenario, shift, hour)
    left = buses_left(corridor, hour)
    streets = design["streets"]
    stats = {}
    for name in corridor.pieces:
        share = {"fiera": 0.56, "pilastro": 0.44}.get(name, 1.0)
        stats[name] = run_piece(
            corridor.piece(name), scenario, streets[name], design["priority"], headway, car_h * share, bus_h * share, bike_h * share, left * share, _piece
        )
    car_fiera = chain_time(stats, "fiera", "car_min")
    car_pilastro = chain_time(stats, "pilastro", "car_min")
    if scenario == "after":
        transit_fiera = tram_trip(corridor, "fiera", design, headway, stats)
        transit_pilastro = tram_trip(corridor, "pilastro", design, headway, stats)
    else:
        transit_fiera = bus_trip(stats, "fiera", corridor)
        transit_pilastro = bus_trip(stats, "pilastro", corridor)
    speeds = {name: item["car_mps"] for name, item in stats.items()}
    bike_speeds = {name: item["bike_mps"] for name, item in stats.items()}
    result = people_and_transit(
        corridor, scenario, shift, headway,
        stats["trunk"]["car_out"], stats["trunk"]["bike_out"],
        transit_fiera, transit_pilastro, speeds, bike_speeds,
        car_fiera, car_pilastro, bike_trip(stats, "fiera", "bike_min", corridor),
        hour=hour,
    )
    result["pieces"] = piece_report(corridor, stats)
    result["priority"] = bool(design["priority"])
    return result
