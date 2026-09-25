"""Cell-transmission model. A Warp kernel is the CUDA port of the same update."""

import math

import numpy as np

from sim import kernels
from sim.engine import bike_trip, bus_trip, chain_time, demand, people_and_transit, tram_minutes

DX = 50.0
DT = 1.0
WAVE = 5.0
QMAX_LANE = 900.0 / 3600.0
KJ_LANE = 0.13


def _rollout(length, lanes, inflow, signals, free, steps, use_warp):
    n = max(2, int(round(length / DX)))
    dx = length / n
    qmax = lanes * QMAX_LANE
    kj = lanes * KJ_LANE
    density = np.zeros(n, dtype=np.float64)
    red = np.zeros(n, dtype=bool)
    offset = np.zeros(n, dtype=np.float64)
    for index, position in enumerate(signals):
        cell = min(n - 1, max(0, int(position / dx)))
        red[cell] = True
        offset[cell] = (index * 17) % 90
    measure_from = steps - min(240, steps // 4)
    travel_sum = 0.0
    outflow = 0.0
    measured_steps = 0
    for step in range(steps):
        clock = step * DT
        scale = np.ones(n, dtype=np.float64)
        if np.any(red):
            phase = np.mod(clock + offset, 90.0)
            scale[red & (phase >= 40.0)] = 0.0
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
    # Long enough for the exit flow to settle, then the last four minutes are kept.
    return int(min(2400, max(700, length / 2.5 + 400)))


def _piece(piece, car_h, bus_h, bike_h, scenario, use_warp):
    lanes = 1 if scenario == "after" and piece.affected else 2
    bus = bus_h if piece.name != "bypass" else 0.0
    if piece.bike_protected:
        pce = car_h + 2.2 * bus
        bike_mps = 5.6
    else:
        pce = car_h + 2.2 * bus + 0.3 * bike_h
        bike_mps = None
    inflow = pce / 3600.0
    seconds, throughput = _rollout(piece.length, lanes, inflow, piece.signals, piece.free, horizon(piece.length), use_warp)
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
        "car_out": car_out,
        "bike_out": bike_out,
    }


def run(corridor, scenario, shift, headway, use_warp=False, hour=8):
    car_h, bus_h, bike_h = demand(corridor, scenario, shift, hour)
    stats = {}
    upstream = car_h
    for name in ("trunk", "bypass", "city"):
        bus_here = bus_h if name != "bypass" else 0.0
        stats[name] = _piece(corridor.piece(name), upstream, bus_here, bike_h if name == "trunk" else bike_h * 0.9, scenario, use_warp)
        upstream = stats[name]["car_out"]
    for name, share in (("fiera", 0.56), ("pilastro", 0.44)):
        stats[name] = _piece(
            corridor.piece(name), upstream * share, bus_h * share, bike_h * share, scenario, use_warp
        )
    speeds = {name: item["car_mps"] for name, item in stats.items()}
    bike_speeds = {name: item["bike_mps"] for name, item in stats.items()}
    if scenario == "after":
        transit_fiera = tram_minutes(corridor, "fiera")
        transit_pilastro = tram_minutes(corridor, "pilastro")
    else:
        transit_fiera = bus_trip(stats, "fiera", corridor)
        transit_pilastro = bus_trip(stats, "pilastro", corridor)
    return people_and_transit(
        corridor, scenario, shift, headway,
        stats["trunk"]["car_out"], stats["trunk"]["bike_out"],
        transit_fiera, transit_pilastro, speeds, bike_speeds,
        chain_time(stats, "fiera", "car_min"),
        chain_time(stats, "pilastro", "car_min"),
        bike_trip(stats, "fiera", "bike_min", corridor),
        hour=hour,
    )
