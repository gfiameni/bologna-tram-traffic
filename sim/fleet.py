"""Fleet plan for the bus trips the tram takes off Via Emilia.

Every trip of the withdrawn lines (public/fleet.json) must still run. A vehicle can follow a trip
with another one if it can drive from the end of the first to the start of the second and rest for
the layover before that trip leaves. The planner finds the fewest vehicles that cover every
trip and, among the plans with that many, the least empty driving, depot pull-out and pull-in
included.

Two solvers give the same kind of answer:
- `solve_cpu` is exact: a minimum-cost matching of each trip to the trip that follows it.
- `solve_cuopt` models the same problem as vehicle routing with time windows on NVIDIA cuOpt.
  It needs a CUDA GPU and the cuopt and cudf packages, for example on DGX Spark.
`solve` runs cuOpt when it can, checks the plan, and keeps the CPU plan whenever cuOpt is
unavailable, fails, or needs more vehicles.

TPER does not publish depots, drivers, layover, or empty-running speed, so those are
assumptions: the values in DEFAULTS, and the options of `solve`.
"""

import json
import math
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FLEET_FILE = ROOT / "public" / "fleet.json"

DEFAULTS = {
    "layover": 5.0,      # minutes a vehicle rests at a terminal before it leaves again
    "deadhead_kmh": 22.0,  # empty running through the city
    "detour": 1.3,       # road distance over straight-line distance
    "depot": None,       # terminal index; None takes the most central terminal
}


def load(path=FLEET_FILE):
    return json.loads(Path(path).read_text())


def haversine_km(a, b):
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat, dlon = lat2 - lat1, math.radians(b["lon"] - a["lon"])
    h = math.sin(dlat / 2) ** 2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlon / 2) ** 2
    return 2 * 6371.0 * math.asin(math.sqrt(min(1.0, h)))


def deadhead(stops, options):
    """Minutes and km of empty running between every pair of terminals."""
    n = len(stops)
    km = [[0.0] * n for _ in range(n)]
    for i in range(n):
        for j in range(n):
            if i != j:
                km[i][j] = haversine_km(stops[i], stops[j]) * options["detour"]
    minutes = [[km[i][j] / options["deadhead_kmh"] * 60.0 for j in range(n)] for i in range(n)]
    return minutes, km


def central_terminal(data):
    """The terminal with the least empty driving to every trip start and end: a neutral depot."""
    stops = data["stops"]
    ends = [trip[key] for trip in data["trips"] for key in ("from", "to")]
    return min(range(len(stops)), key=lambda d: sum(haversine_km(stops[d], stops[e]) for e in ends))


def options_for(data, **given):
    options = {**DEFAULTS, **{key: value for key, value in given.items() if value is not None}}
    if options["depot"] is None:
        options["depot"] = central_terminal(data)
    return options


VEHICLE_COST = 100000.0  # minutes: one vehicle less is worth more than any amount of empty driving
NO_LINK = 1e12


def link_costs(data, options):
    """cost[i][k] is what it saves, in empty minutes, for one vehicle to drive trip k right after trip i.

    The link removes the drive from the end of i to the depot and from the depot to the start of k,
    adds the drive from i to k, and saves a vehicle. None means the vehicle cannot make it in time.
    """
    trips, stops = data["trips"], data["stops"]
    minutes, _km = deadhead(stops, options)
    depot = options["depot"]
    cost = []
    for first in trips:
        row = []
        back = minutes[first["to"]][depot]
        for second in trips:
            drive = minutes[first["to"]][second["from"]]
            ready = first["end"] + drive + options["layover"]
            if second is first or ready > second["start"] + 1e-9:
                row.append(None)
            else:
                row.append(drive - back - minutes[depot][second["from"]] - VEHICLE_COST)
        cost.append(row)
    return cost


def assign(cost):
    """Minimum-cost assignment of rows to columns (Hungarian method), for a rows x columns list with rows <= columns."""
    rows, cols = len(cost), len(cost[0])
    inf = float("inf")
    u, v = [0.0] * (rows + 1), [0.0] * (cols + 1)
    match, way = [0] * (cols + 1), [0] * (cols + 1)
    for row in range(1, rows + 1):
        match[0] = row
        col0 = 0
        minv = [inf] * (cols + 1)
        used = [False] * (cols + 1)
        while True:
            used[col0] = True
            r0, delta, col1 = match[col0], inf, 0
            cr = cost[r0 - 1]
            ur = u[r0]
            for col in range(1, cols + 1):
                if used[col]:
                    continue
                current = cr[col - 1] - ur - v[col]
                if current < minv[col]:
                    minv[col], way[col] = current, col0
                if minv[col] < delta:
                    delta, col1 = minv[col], col
            for col in range(cols + 1):
                if used[col]:
                    u[match[col]] += delta
                    v[col] -= delta
                else:
                    minv[col] -= delta
            col0 = col1
            if match[col0] == 0:
                break
        while col0:
            col1 = way[col0]
            match[col0] = match[col1]
            col0 = col1
    chosen = [-1] * rows
    for col in range(1, cols + 1):
        if match[col]:
            chosen[match[col] - 1] = col - 1
    return chosen


def solve_cpu(data, **given):
    """Exact plan: the fewest vehicles, and among those the least empty driving.

    Each trip is followed by at most one trip, so the plan is a minimum-cost matching of trips to the trip
    that follows them. A trip with no follower ends its vehicle's day.
    """
    options = options_for(data, **given)
    n = len(data["trips"])
    cost = link_costs(data, options)
    # Columns 0..n-1 are the trip that follows; the n columns after them mean "no follower" at no cost.
    matrix = [[(NO_LINK if c is None else c) for c in row] + [0.0] * n for row in cost]
    chosen = assign(matrix)
    after = {i: k for i, k in enumerate(chosen) if 0 <= k < n and cost[i][k] is not None}
    has_previous = set(after.values())
    chains = []
    for head in range(n):
        if head in has_previous:
            continue
        chain = [head]
        while chain[-1] in after:
            chain.append(after[chain[-1]])
        chains.append(chain)
    return report(data, options, chains, "cpu")


def report(data, options, chains, backend, note=None):
    """The plan as vehicles, with the figures a planner reads."""
    trips, stops = data["trips"], data["stops"]
    minutes, km = deadhead(stops, options)
    depot = options["depot"]
    vehicles = []
    for chain in sorted(chains, key=lambda c: trips[c[0]]["start"]):
        first, last = trips[chain[0]], trips[chain[-1]]
        empty_km = km[depot][first["from"]] + km[last["to"]][depot]
        empty_min = minutes[depot][first["from"]] + minutes[last["to"]][depot]
        for a, b in zip(chain, chain[1:]):
            empty_km += km[trips[a]["to"]][trips[b]["from"]]
            empty_min += minutes[trips[a]["to"]][trips[b]["from"]]
        vehicles.append({
            "trips": [trips[k]["id"] for k in chain],
            "start": first["start"],
            "end": last["end"],
            "serviceMin": round(sum(trips[k]["end"] - trips[k]["start"] for k in chain), 1),
            "emptyKm": round(empty_km, 1),
            "emptyMin": round(empty_min, 1),
        })
    return {
        "backend": backend,
        "note": note,
        "fleet": len(vehicles),
        "peak": peak_vehicles(data, options),
        "trips": len(trips),
        "serviceHours": round(sum(v["serviceMin"] for v in vehicles) / 60.0, 1),
        "emptyKm": round(sum(v["emptyKm"] for v in vehicles), 1),
        "options": options,
        "vehicles": vehicles,
    }


def peak_vehicles(data, options):
    """A lower bound on the fleet: the most trips under way at once, counting each layover."""
    events = []
    for trip in data["trips"]:
        events.append((trip["start"], 1))
        events.append((trip["end"] + options["layover"], -1))
    peak = current = 0
    for _time, change in sorted(events, key=lambda e: (e[0], e[1])):
        current += change
        peak = max(peak, current)
    return peak


def check(data, plan):
    """Problems with a plan: a trip left out or run twice, or a link no vehicle could drive. Empty means fine."""
    options = plan["options"]
    index = {trip["id"]: trip for trip in data["trips"]}
    minutes, _km = deadhead(data["stops"], options)
    seen = {}
    problems = []
    for number, vehicle in enumerate(plan["vehicles"]):
        for a, b in zip(vehicle["trips"], vehicle["trips"][1:]):
            first, second = index[a], index[b]
            need = first["end"] + minutes[first["to"]][second["from"]] + options["layover"]
            if need > second["start"] + 1e-6:
                problems.append(f"vehicle {number}: {a} to {b} needs until {need:.1f}, trip leaves {second['start']}")
        for trip_id in vehicle["trips"]:
            seen[trip_id] = seen.get(trip_id, 0) + 1
    for trip_id in index:
        if seen.get(trip_id, 0) != 1:
            problems.append(f"trip {trip_id} is covered {seen.get(trip_id, 0)} times")
    return problems


def solve_cuopt(data, time_limit=10.0, **given):
    """The same problem on cuOpt: trips are orders with a one-minute start window, the depot is a terminal."""
    import cudf
    import numpy as np
    from cuopt import routing

    options = options_for(data, **given)
    trips = data["trips"]
    n = len(trips)
    minutes, _km = deadhead(data["stops"], options)
    depot = options["depot"]
    # Node 0 is the depot, node k + 1 is trip k. Arriving at a trip node means starting that trip, so the
    # time from trip i to trip j is the run of i, the empty drive, and the layover.
    size = n + 1
    matrix = np.zeros((size, size), dtype="float32")
    for i in range(size):
        for j in range(size):
            if i == j:
                continue
            if i == 0:
                matrix[i, j] = minutes[depot][trips[j - 1]["from"]]
            else:
                run = trips[i - 1]["end"] - trips[i - 1]["start"]
                target = depot if j == 0 else trips[j - 1]["from"]
                matrix[i, j] = run + minutes[trips[i - 1]["to"]][target] + (options["layover"] if j else 0.0)
    model = routing.DataModel(size, n, n)
    frame = cudf.DataFrame(matrix)
    model.add_cost_matrix(frame)
    model.add_transit_time_matrix(frame)
    model.set_order_locations(cudf.Series(list(range(1, size)), dtype="int32"))
    model.set_order_time_windows(
        cudf.Series([t["start"] for t in trips], dtype="int32"),
        cudf.Series([t["start"] + 1 for t in trips], dtype="int32"),
    )
    model.set_order_service_times(cudf.Series([0] * n, dtype="int32"))
    model.set_vehicle_locations(cudf.Series([0] * n, dtype="int32"), cudf.Series([0] * n, dtype="int32"))
    model.set_vehicle_time_windows(
        cudf.Series([0] * n, dtype="int32"),
        cudf.Series([int(max(t["end"] for t in trips)) + 600] * n, dtype="int32"),
    )
    settings = routing.SolverSettings()
    settings.set_time_limit(time_limit)
    solution = routing.Solve(model, settings)
    if solution.get_status() != 0:
        raise RuntimeError(f"cuOpt status {solution.get_status()}: {solution.get_error_message()}")
    route = solution.get_route().to_pandas()
    chains = []
    for _truck, rows in route.groupby("truck_id"):
        chain = [int(loc) - 1 for loc in rows.sort_values("arrival_stamp")["location"] if int(loc) > 0]
        if chain:
            chains.append(chain)
    return report(data, options, chains, "cuopt")


def solve(data, backend="auto", **given):
    """A checked plan. `auto` tries cuOpt and keeps the CPU plan if cuOpt is missing, fails, or is worse."""
    baseline = solve_cpu(data, **given)
    problems = check(data, baseline)
    if problems:
        raise RuntimeError("the CPU plan failed its check: " + problems[0])
    if backend == "cpu":
        return baseline
    try:
        plan = solve_cuopt(data, **given)
    except Exception as error:  # no GPU, package missing, or a solver failure
        if backend == "cuopt":
            raise
        baseline["note"] = f"cuOpt not used: {type(error).__name__}: {error}"
        return baseline
    problems = check(data, plan)
    if problems:
        baseline["note"] = "cuOpt plan rejected: " + problems[0]
        return baseline
    plan["cpuFleet"] = baseline["fleet"]
    if plan["fleet"] > baseline["fleet"] and backend == "auto":
        baseline["note"] = f"cuOpt needed {plan['fleet']} vehicles against {baseline['fleet']}: kept the CPU plan"
        return baseline
    return plan


if __name__ == "__main__":
    result = solve(load(), backend=sys.argv[1] if len(sys.argv) > 1 else "auto")
    print(json.dumps({key: value for key, value in result.items() if key != "vehicles"}, indent=2))
