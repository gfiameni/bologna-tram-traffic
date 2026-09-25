"""Intelligent Driver Model, with acceleration evaluated by a Warp kernel."""

import numpy as np

from sim import kernels
from sim.engine import bike_trip, bus_trip, chain_time, demand, people_and_transit, tram_minutes

DT = 0.5
HORIZON = 280.0
WARMUP = 80.0

PARAMS = {
    0: (13.9, 1.2, 2.0, 1.2, 2.0, 5.0),
    1: (11.5, 0.8, 1.5, 1.5, 3.0, 12.0),
    2: (5.4, 0.9, 1.4, 0.8, 1.0, 2.0),
}


def _accel_numpy(pos, vel, lead_pos, lead_vel, v0, veh_len, accel, brake, headway, s0):
    gap = np.maximum(0.4, lead_pos - pos - veh_len)
    closing = vel - lead_vel
    desired = s0 + vel * headway + vel * closing / (2.0 * math_sqrt(accel * brake))
    desired = np.maximum(s0, desired)
    ratio = vel / np.maximum(v0, 0.1)
    free = ratio ** 4
    return accel * (1.0 - free - (desired / gap) ** 2)


def math_sqrt(value):
    return value ** 0.5


def _leaders(pos, length):
    order = np.argsort(pos)
    lead_pos = np.empty_like(pos)
    lead_vel_index = np.empty(len(pos), dtype=np.int32)
    for rank, index in enumerate(order):
        if rank + 1 < len(order):
            ahead = order[rank + 1]
            lead_pos[index] = pos[ahead]
            lead_vel_index[index] = ahead
        else:
            lead_pos[index] = pos[index] + length + 80.0
            lead_vel_index[index] = index
    return lead_pos, lead_vel_index


def _stream(length, signals, stops, arrivals, use_warp, bike_only=False):
    """arrivals is a list of (kind, first_time, headway)."""
    pos = np.zeros(0)
    vel = np.zeros(0)
    kind = np.zeros(0, dtype=np.int32)
    dwell = np.zeros(0)
    served = []
    next_spawn = [first for _kind, first, _hw in arrivals]
    entered = {0: 0, 1: 0, 2: 0}
    exited = {0: 0.0, 1: 0.0, 2: 0.0}
    speed_sum = {0: 0.0, 1: 0.0, 2: 0.0}
    speed_n = {0: 0, 1: 0, 2: 0}
    steps = int(HORIZON / DT)
    for step in range(steps):
        clock = step * DT
        for index, (vehicle_kind, _first, headway) in enumerate(arrivals):
            if bike_only and vehicle_kind != 2:
                continue
            if not bike_only and vehicle_kind == 2 and arrivals and any(item[0] == 2 and item is not arrivals[index] for item in []):
                pass
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
            entered[vehicle_kind] += 1
            next_spawn[index] += headway
        if len(pos) == 0:
            continue
        order_lead, lead_index = _leaders(pos, length)
        lead_vel = vel[lead_index]
        for signal in signals:
            phase = (clock + (signal * 0.1)) % 90.0
            if phase >= 40.0:
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
                    dwell[index] = 18.0
                    vel[index] = 0.0
        gone = pos >= length
        if clock >= WARMUP:
            for vehicle_kind in (0, 1, 2):
                chosen = kind == vehicle_kind
                if np.any(chosen):
                    speed_sum[vehicle_kind] += float(np.mean(vel[chosen]))
                    speed_n[vehicle_kind] += 1
            detector = min(length * 0.45, 450.0)
            crossed = (prev < detector) & (pos >= detector)
            for vehicle_kind in (0, 1, 2):
                exited[vehicle_kind] += float(np.sum(crossed & (kind == vehicle_kind)))
        if np.any(gone):
            keep = ~gone
            pos, vel, kind, dwell = pos[keep], vel[keep], kind[keep], dwell[keep]
            served = [item for item, flag in zip(served, keep) if flag]
    measured = max(1.0, HORIZON - WARMUP)
    out = {}
    for vehicle_kind, label in ((0, "car"), (1, "bus"), (2, "bike")):
        mean = speed_sum[vehicle_kind] / speed_n[vehicle_kind] if speed_n[vehicle_kind] else 0.4
        mean = max(mean, 0.4)
        out[label] = {
            "mps": mean,
            "minutes": (length / mean) / 60.0,
            "per_hour": exited[vehicle_kind] / measured * 3600.0,
        }
    return out


def _piece(piece, car_h, bus_h, bike_h, scenario, use_warp):
    lanes = 1 if scenario == "after" and piece.affected else 2
    # Lanes scale the arrival headway: two lanes means half the following distance.
    car_hw = (3600.0 / max(car_h, 1.0)) * lanes
    bus_hw = (3600.0 / bus_h) if bus_h > 1 else 0.0
    bike_hw = (3600.0 / max(bike_h, 1.0)) if bike_h > 1 else 0.0
    if piece.name == "bypass":
        bus_hw = 0.0
    if piece.bike_protected:
        mixed = _stream(piece.length, piece.signals, piece.stops, [(0, 0.0, car_hw), (1, 4.0, bus_hw)], use_warp)
        bikes = _stream(piece.length, [], [], [(2, 0.5, bike_hw)], use_warp, bike_only=True)
        bike = bikes["bike"]
    else:
        mixed = _stream(
            piece.length, piece.signals, piece.stops,
            [(0, 0.0, car_hw), (1, 4.0, bus_hw), (2, 1.0, bike_hw)],
            use_warp,
        )
        bike = mixed["bike"]
    return {
        "car_min": mixed["car"]["minutes"],
        "bus_min": mixed["bus"]["minutes"] if bus_hw > 0 else mixed["car"]["minutes"],
        "bike_min": bike["minutes"] if bike_hw > 0 else mixed["car"]["minutes"],
        "car_mps": mixed["car"]["mps"],
        "bike_mps": bike["mps"],
        "car_out": mixed["car"]["per_hour"] * lanes,
        "bike_out": bike["per_hour"],
    }


def run(corridor, scenario, shift, headway, use_warp=False, hour=8):
    car_h, bus_h, bike_h = demand(corridor, scenario, shift, hour)
    stats = {}
    upstream = car_h
    bike_up = bike_h
    for name in ("trunk", "bypass", "city"):
        stats[name] = _piece(
            corridor.piece(name), upstream, bus_h if name != "bypass" else 0.0, bike_up, scenario, use_warp
        )
        upstream = min(upstream, stats[name]["car_out"])
        bike_up = min(bike_up, max(stats[name]["bike_out"], 1.0))
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
        min(car_h, stats["trunk"]["car_out"]), min(bike_h, stats["trunk"]["bike_out"]),
        transit_fiera, transit_pilastro, speeds, bike_speeds,
        chain_time(stats, "fiera", "car_min"),
        chain_time(stats, "pilastro", "car_min"),
        bike_trip(stats, "fiera", "bike_min", corridor),
        hour=hour,
    )
