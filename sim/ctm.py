"""Cell-transmission model. A Warp kernel is the CUDA port of the same update."""

import numpy as np

from sim import kernels
from sim.design import SATURATION_PER_LANE, TODAY_CYCLE_S, TODAY_GREEN_S, measure_window, offsets, signal_plan, street_layout
from sim.engine import bike_trip, bus_trip, chain_time, demand, people_and_transit, piece_report, tram_trip

DX = 50.0
DT = 1.0
WAVE = 5.0
QMAX_LANE = SATURATION_PER_LANE / 3600.0
KJ_LANE = 0.13
TODAY = {"cycle": TODAY_CYCLE_S, "green": TODAY_GREEN_S, "carGreen": TODAY_GREEN_S, "wave": False, "tramWait": 0.0}


def _rollout(length, lanes, inflow, signals, free, steps, use_warp, plan=None):
    plan = plan or TODAY
    cycle = plan["cycle"]
    green = plan["carGreen"]
    n = max(2, int(round(length / DX)))
    dx = length / n
    qmax = lanes * QMAX_LANE
    kj = lanes * KJ_LANE
    density = np.zeros(n, dtype=np.float64)
    red = np.zeros(n, dtype=bool)
    offset = np.zeros(n, dtype=np.float64)
    for position, shift in zip(signals, offsets(signals, plan, "ctm")):
        # A light in the entry cell would turn arriving cars away instead of queueing them.
        cell = min(n - 1, max(1, int(position / dx)))
        red[cell] = True
        offset[cell] = shift
    measure_from = steps
    steps = steps + int(round(measure_window(cycle) / DT))
    travel_sum = 0.0
    outflow = 0.0
    measured_steps = 0
    for step in range(steps):
        clock = step * DT
        scale = np.ones(n, dtype=np.float64)
        if np.any(red):
            phase = np.mod(clock + offset, cycle)
            scale[red & (phase >= green)] = 0.0
        if use_warp:
            updated = kernels.ctm_step(density, scale, qmax, kj, free, WAVE, dx, DT, inflow)
            if updated is None:
                use_warp = False
            else:
                density = updated
        if not use_warp:
            send = np.minimum(free * density, qmax) * scale
            receive = np.minimum(WAVE * np.maximum(kj - density, 0.0), qmax) * scale
            flow_in = np.empty(n)
            flow_in[0] = min(inflow, receive[0])
            flow_in[1:] = np.minimum(send[:-1], receive[1:])
            flow_out = np.empty(n)
            flow_out[:-1] = flow_in[1:]
            flow_out[-1] = send[-1]
            density = np.maximum(0.0, density + DT / dx * (flow_in - flow_out))
        if step >= measure_from:
            send = np.minimum(free * density, qmax) * scale
            speed = np.full(n, free)
            moving = density > 1e-5
            speed[moving] = np.minimum(free, send[moving] / density[moving])
            speed = np.maximum(speed, 0.5)
            travel_sum += float(np.sum(dx / speed))
            outflow += float(send[-1] * DT)
            measured_steps += 1
    measured = max(1.0, measured_steps * DT)
    return travel_sum / max(1, measured_steps), outflow / measured * 3600.0


def horizon(length):
    # Seconds of warm-up, long enough for the exit flow to settle. Whole cycles are measured after it.
    return int(min(2150, max(460, length / 2.5 + 160)))


def _piece(piece, car_h, bus_h, bike_h, scenario, use_warp, layout, plan):
    lanes = layout["lanes"]
    bus = bus_h if piece.name != "bypass" else 0.0
    if piece.bike_protected:
        pce = car_h + 2.2 * bus
        bike_mps = 5.6
    else:
        pce = car_h + 2.2 * bus + 0.3 * bike_h
        bike_mps = None
    inflow = pce / 3600.0
    seconds, throughput = _rollout(piece.length, lanes, inflow, piece.signals, piece.free, horizon(piece.length), use_warp, plan)
    car_share = car_h / max(1.0, pce)
    bike_share = (0.0 if piece.bike_protected else bike_h) / max(1.0, pce)
    car_out = throughput * car_share
    bike_out = bike_h if piece.bike_protected else throughput * bike_share
    car_mps = piece.length / max(seconds, 1.0)
    if bike_mps is None:
        bike_mps = min(4.6, car_mps * 0.9)
    bus_mps = min(car_mps, 11.0)
    return {
        "car_min": seconds / 60.0,
        "bus_min": (piece.length / max(bus_mps, 0.5) + 20 * len(piece.stops)) / 60.0,
        "bike_min": (piece.length / bike_mps) / 60.0,
        "car_mps": car_mps,
        "bike_mps": bike_mps,
        "car_in": car_h,
        "pce_in": pce,
        "car_out": min(car_h, car_out),
        "bike_out": bike_out,
    }


def run(corridor, scenario, shift, headway, use_warp=False, hour=8, design=None):
    car_h, bus_h, bike_h = demand(corridor, scenario, shift, hour)
    streets = design["streets"]
    layouts = {name: street_layout(corridor.piece(name), scenario, streets[name]) for name in corridor.pieces}
    plans = {name: signal_plan(corridor.piece(name), scenario, streets[name], design["priority"], headway) for name in corridor.pieces}
    stats = {}
    upstream = car_h
    for name in ("trunk", "bypass", "city"):
        bus_here = bus_h if name != "bypass" else 0.0
        stats[name] = _piece(corridor.piece(name), upstream, bus_here, bike_h if name == "trunk" else bike_h * 0.9, scenario, use_warp, layouts[name], plans[name])
        upstream = stats[name]["car_out"]
    for name, share in (("fiera", 0.56), ("pilastro", 0.44)):
        stats[name] = _piece(
            corridor.piece(name), upstream * share, bus_h * share, bike_h * share, scenario, use_warp, layouts[name], plans[name]
        )
    speeds = {name: item["car_mps"] for name, item in stats.items()}
    bike_speeds = {name: item["bike_mps"] for name, item in stats.items()}
    if scenario == "after":
        transit_fiera = tram_trip(corridor, "fiera", plans)
        transit_pilastro = tram_trip(corridor, "pilastro", plans)
    else:
        transit_fiera = bus_trip(stats, "fiera", corridor)
        transit_pilastro = bus_trip(stats, "pilastro", corridor)
    result = people_and_transit(
        corridor, scenario, shift, headway,
        stats["trunk"]["car_out"], stats["trunk"]["bike_out"],
        transit_fiera, transit_pilastro, speeds, bike_speeds,
        chain_time(stats, "fiera", "car_min"),
        chain_time(stats, "pilastro", "car_min"),
        bike_trip(stats, "fiera", "bike_min", corridor),
        hour=hour,
    )
    result["pieces"] = piece_report(corridor, stats, layouts, plans)
    result["priority"] = bool(design["priority"])
    return result
