"""Intelligent Driver Model, with acceleration evaluated by a Warp kernel.

Each street is driven for its first 2.5 km at most. Cars are counted at the end
of that stretch over whole signal cycles, and the travel time scales to the full
length from the mean speed.
"""

import math

import numpy as np

from sim import kernels
from sim.design import TODAY_CYCLE_S, TODAY_GREEN_S, measure_window, offsets, signal_plan, street_layout
from sim.engine import bike_trip, bus_trip, chain_time, demand, people_and_transit, piece_report, tram_trip

TODAY = {"cycle": TODAY_CYCLE_S, "green": TODAY_GREEN_S, "carGreen": TODAY_GREEN_S, "wave": False, "tramWait": 0.0}

DT = 0.5
REACH_M = 2500.0
DWELL_S = 18.0

# Cars and buses are capped at the 30 km/h urban limit. Bicycles stay slower than that.
LIMIT_MPS = 30 / 3.6
PARAMS = {
    0: (LIMIT_MPS, 1.2, 2.0, 1.2, 2.0, 5.0),
    1: (LIMIT_MPS, 0.8, 1.5, 1.5, 3.0, 12.0),
    2: (5.4, 0.9, 1.4, 0.8, 1.0, 2.0),
}


def _accel_numpy(pos, vel, lead_pos, lead_vel, v0, veh_len, accel, brake, headway, s0):
    gap = np.maximum(0.4, lead_pos - pos - veh_len)
    closing = vel - lead_vel
    desired = s0 + vel * headway + vel * closing / (2.0 * math.sqrt(accel * brake))
    desired = np.maximum(s0, desired)
    ratio = vel / np.maximum(v0, 0.1)
    squared = ratio * ratio
    pressure = desired / gap
    return accel * (1.0 - squared * squared - pressure * pressure)


def _leaders(pos, length, hidden):
    """Position and index of the vehicle ahead. Hidden vehicles (buses at a stop on a two-lane street) are passed."""
    order = np.argsort(pos, kind="stable")
    lead_pos = np.empty_like(pos)
    lead_vel_index = np.empty(len(pos), dtype=np.int32)
    ahead = -1
    for index in order[::-1]:
        if ahead < 0:
            lead_pos[index] = pos[index] + length + 80.0
            lead_vel_index[index] = index
        else:
            lead_pos[index] = pos[ahead]
            lead_vel_index[index] = ahead
        if not hidden[index]:
            ahead = index
    return lead_pos, lead_vel_index


def _stream(length, signals, stops, arrivals, use_warp, bike_only=False, plan=None, lanes=1):
    """arrivals is a list of (kind, first_time, headway)."""
    plan = plan or TODAY
    cycle = plan["cycle"]
    green = plan["carGreen"]
    full = length
    length = min(length, REACH_M)
    lights = [(signal, shift) for signal, shift in zip(signals, offsets(signals, plan, "idm")) if signal < length]
    stops = [stop for stop in stops if stop < length]
    # Long enough for the stream to reach the detector at under half the limit.
    warmup_steps = int(math.ceil((2.2 * length / LIMIT_MPS + 60.0) / DT))
    window_steps = int(round(measure_window(cycle) / DT))
    pos = np.zeros(0)
    vel = np.zeros(0)
    kind = np.zeros(0, dtype=np.int32)
    dwell = np.zeros(0)
    served = []
    next_spawn = [first for _kind, first, _hw in arrivals]
    distance = {0: 0.0, 1: 0.0, 2: 0.0}
    time_spent = {0: 0.0, 1: 0.0, 2: 0.0}
    steps = warmup_steps + window_steps
    for step in range(steps):
        clock = step * DT
        for index, (vehicle_kind, _first, headway) in enumerate(arrivals):
            if bike_only and vehicle_kind != 2:
                continue
            if headway <= 0 or clock + 1e-6 < next_spawn[index]:
                continue
            blocked = len(pos) and np.min(np.where(kind == vehicle_kind, pos, 1e9)) < 8.0
            if blocked:
                continue
            pos = np.append(pos, 0.0)
            vel = np.append(vel, 0.2)
            kind = np.append(kind, vehicle_kind)
            dwell = np.append(dwell, 0.0)
            served.append(set())
            next_spawn[index] += headway
        if len(pos) == 0:
            continue
        # With a second lane, cars pass bicycles and buses at a stop.
        hidden = (((kind == 1) & (dwell > 0)) | (kind == 2)) if lanes > 1 else np.zeros(len(pos), dtype=bool)
        order_lead, lead_index = _leaders(pos, length, hidden)
        lead_vel = vel[lead_index]
        for signal, shift in lights:
            phase = (clock + shift) % cycle
            if phase >= green:
                waiting = (pos < signal) & (signal - pos < order_lead - pos)
                order_lead = np.where(waiting, signal, order_lead)
                lead_vel = np.where(waiting, 0.0, lead_vel)
        v0 = np.array([PARAMS[int(item)][0] for item in kind])
        veh_len = np.array([PARAMS[int(item)][5] for item in kind])
        # One parameter set for the kernel; buses and bikes are close enough that
        # the per-class desired speed carries the difference. Headway uses the car value
        # scaled below for non-cars in the numpy path.
        if use_warp and kernels.available():
            accel = kernels.idm_accelerations(pos, vel, order_lead, lead_vel, v0, veh_len, 1.2, 2.0, 1.2, 2.0)
        else:
            accel = None
        if accel is None:
            accel = _accel_numpy(pos, vel, order_lead, lead_vel, v0, veh_len, 1.2, 2.0, 1.2, 2.0)
        accel = np.clip(accel, -3.5, 1.6)
        stopped = dwell > 0
        vel = np.where(stopped, 0.0, np.clip(vel + accel * DT, 0.0, v0))
        prev = pos.copy()
        pos = pos + vel * DT
        dwell = np.maximum(0.0, dwell - DT)
        for index in range(len(pos)):
            if kind[index] != 1 or dwell[index] > 0:
                continue
            for stop in stops:
                if stop in served[index]:
                    continue
                if pos[index] >= stop:
                    served[index].add(stop)
                    dwell[index] = DWELL_S
                    vel[index] = 0.0
        gone = pos >= length
        if step >= warmup_steps:
            # Edie's definitions: distance and time spent inside the stretch over the window.
            moved = np.minimum(pos, length) - prev
            for vehicle_kind in (0, 1, 2):
                chosen = kind == vehicle_kind
                distance[vehicle_kind] += float(np.sum(moved[chosen]))
                time_spent[vehicle_kind] += int(np.sum(chosen)) * DT
        if np.any(gone):
            keep = ~gone
            pos, vel, kind, dwell = pos[keep], vel[keep], kind[keep], dwell[keep]
            served = [item for item, flag in zip(served, keep) if flag]
    measured = window_steps * DT
    out = {}
    for vehicle_kind, label in ((0, "car"), (1, "bus"), (2, "bike")):
        seen = time_spent[vehicle_kind] > 0
        mean = max(0.4, distance[vehicle_kind] / time_spent[vehicle_kind]) if seen else None
        out[label] = {
            "mps": mean,
            "minutes": (full / mean) / 60.0 if seen else None,
            "per_hour": distance[vehicle_kind] / (length * measured) * 3600.0,
        }
    return out


def _piece(piece, car_h, bus_h, bike_h, use_warp, layout, plan):
    lanes = layout["lanes"]
    # Lanes scale the arrival headway: two lanes means half the following distance.
    car_hw = (3600.0 / max(car_h, 1.0)) * lanes
    bus_hw = (3600.0 / bus_h) if bus_h > 1 else 0.0
    bike_hw = (3600.0 / max(bike_h, 1.0)) if bike_h > 1 else 0.0
    if piece.name == "bypass":
        bus_hw = 0.0
    if piece.bike_protected:
        mixed = _stream(piece.length, piece.signals, piece.stops, [(0, 0.0, car_hw), (1, 4.0, bus_hw)], use_warp, plan=plan, lanes=lanes)
        bikes = _stream(piece.length, [], [], [(2, 0.5, bike_hw)], use_warp, bike_only=True)
        bike = bikes["bike"]
        pce = car_h + 2.2 * (bus_h if bus_hw > 0 else 0.0)
    else:
        mixed = _stream(
            piece.length, piece.signals, piece.stops,
            [(0, 0.0, car_hw), (1, 4.0, bus_hw), (2, 1.0, bike_hw)],
            use_warp,
            plan=plan,
            lanes=lanes,
        )
        bike = mixed["bike"]
        pce = car_h + 2.2 * (bus_h if bus_hw > 0 else 0.0) + 0.3 * bike_h
    car = mixed["car"]
    if car["mps"] is None:
        car = {"mps": piece.free, "minutes": piece.length / piece.free / 60.0}
    bus_min = mixed["bus"]["minutes"]
    if bus_min is None:
        bus_min = (piece.length / min(car["mps"], 11.0) + DWELL_S * len(piece.stops)) / 60.0
    bike_mps = bike["mps"] if bike["mps"] is not None else min(5.4, car["mps"])
    return {
        "car_min": car["minutes"],
        "bus_min": bus_min,
        "bike_min": piece.length / bike_mps / 60.0,
        "car_mps": car["mps"],
        "bike_mps": bike_mps,
        "car_in": car_h,
        "pce_in": pce,
        "car_out": min(car_h, mixed["car"]["per_hour"] * lanes),
        "bike_out": bike["per_hour"],
    }


def run(corridor, scenario, shift, headway, use_warp=False, hour=8, design=None):
    car_h, bus_h, bike_h = demand(corridor, scenario, shift, hour)
    streets = design["streets"]
    layouts = {name: street_layout(corridor.piece(name), scenario, streets[name]) for name in corridor.pieces}
    plans = {name: signal_plan(corridor.piece(name), scenario, streets[name], design["priority"], headway) for name in corridor.pieces}
    stats = {}
    upstream = car_h
    bike_up = bike_h
    for name in ("trunk", "bypass", "city"):
        stats[name] = _piece(
            corridor.piece(name), upstream, bus_h if name != "bypass" else 0.0, bike_up, use_warp, layouts[name], plans[name]
        )
        upstream = min(upstream, stats[name]["car_out"])
        bike_up = min(bike_up, max(stats[name]["bike_out"], 1.0))
    for name, share in (("fiera", 0.56), ("pilastro", 0.44)):
        stats[name] = _piece(
            corridor.piece(name), upstream * share, bus_h * share, bike_h * share, use_warp, layouts[name], plans[name]
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
        min(car_h, stats["trunk"]["car_out"]), min(bike_h, stats["trunk"]["bike_out"]),
        transit_fiera, transit_pilastro, speeds, bike_speeds,
        chain_time(stats, "fiera", "car_min"),
        chain_time(stats, "pilastro", "car_min"),
        bike_trip(stats, "fiera", "bike_min", corridor),
        hour=hour,
    )
    result["pieces"] = piece_report(corridor, stats, layouts, plans)
    result["priority"] = bool(design["priority"])
    return result
