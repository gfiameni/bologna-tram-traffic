"""Volume-delay model with signals, buses, and bicycles."""

from sim.engine import bike_trip, bus_trip, chain_time, demand, people_and_transit, tram_minutes

CAP_PER_LANE = 900
ALPHA = 0.8


def _speed(flow, lanes, free):
    capacity = max(1.0, lanes * CAP_PER_LANE)
    ratio = flow / capacity
    return free / (1.0 + ALPHA * ratio * ratio)


def _signal_delay(flow, lanes, signals):
    delay = 0.0
    saturation = max(1.0, lanes * CAP_PER_LANE)
    for _signal in signals:
        green = 40 / 90
        volume = min(0.92, flow / (saturation * green))
        delay += 0.5 * 90 * (1 - green) ** 2 / max(0.08, 1 - green * volume)
    return delay


def _piece(piece, car_h, bus_h, bike_h, scenario):
    lanes = 1 if scenario == "after" and piece.affected else 2
    bus = bus_h if piece.name != "bypass" else 0.0
    if piece.bike_protected:
        pce = car_h + 2.2 * bus
        bike_mps = 5.6
    else:
        pce = car_h + 2.2 * bus + 0.3 * bike_h
        bike_mps = None
    car_mps = _speed(pce, lanes, piece.free)
    if bike_mps is None:
        bike_mps = min(4.6, car_mps * 0.9)
    delay = _signal_delay(pce, lanes, piece.signals)
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
        "car_out": car_h,
        "bike_out": bike_h,
    }


def run(corridor, scenario, shift, headway):
    car_h, bus_h, bike_h = demand(corridor, scenario, shift)
    stats = {name: _piece(corridor.piece(name), car_h if name not in ("fiera", "pilastro") else car_h * (0.56 if name == "fiera" else 0.44), bus_h, bike_h, scenario) for name in corridor.pieces}
    # Spur inflows are the branch share of the upstream flow.
    for name, share in (("fiera", 0.56), ("pilastro", 0.44)):
        stats[name] = _piece(corridor.piece(name), car_h * share, bus_h * share, bike_h * share, scenario)
    car_fiera = chain_time(stats, "fiera", "car_min")
    car_pilastro = chain_time(stats, "pilastro", "car_min")
    if scenario == "after":
        transit_fiera = tram_minutes(corridor, "fiera")
        transit_pilastro = tram_minutes(corridor, "pilastro")
    else:
        transit_fiera = bus_trip(stats, "fiera", corridor)
        transit_pilastro = bus_trip(stats, "pilastro", corridor)
    speeds = {name: item["car_mps"] for name, item in stats.items()}
    bike_speeds = {name: item["bike_mps"] for name, item in stats.items()}
    return people_and_transit(
        corridor, scenario, shift, headway,
        stats["trunk"]["car_out"], stats["trunk"]["bike_out"],
        transit_fiera, transit_pilastro, speeds, bike_speeds,
        car_fiera, car_pilastro, bike_trip(stats, "fiera", "bike_min", corridor),
    )
