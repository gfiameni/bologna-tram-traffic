"""Checks for the fleet planner. Needs only the standard library."""

import copy
import random

from sim import fleet


def check(name, ok):
    print(("ok  " if ok else "FAIL") + " " + name)
    if not ok:
        raise SystemExit(1)


def small(trips):
    """Three terminals in a row, 5 km apart: A, B, C."""
    stops = [
        {"id": "A", "name": "A", "lat": 44.50, "lon": 11.30},
        {"id": "B", "name": "B", "lat": 44.50, "lon": 11.36},
        {"id": "C", "name": "C", "lat": 44.50, "lon": 11.42},
    ]
    return {
        "stops": stops,
        "trips": [
            {"id": f"t{n}", "line": 0, "from": a, "to": b, "start": start, "end": end}
            for n, (a, b, start, end) in enumerate(trips)
        ],
    }


def brute_force(data, options):
    """Fewest vehicles, then least empty minutes, by trying every way to chain the trips."""
    trips = data["trips"]
    n = len(trips)
    cost = fleet.link_costs(data, options)
    best = [None]

    def explore(i, taken, links, saved):
        if i == n:
            key = (n - links, saved)  # vehicles, then the summed link cost (lower is better)
            if best[0] is None or key < best[0]:
                best[0] = key
            return
        explore(i + 1, taken, links, saved)
        for k in range(n):
            if k not in taken and cost[i][k] is not None:
                explore(i + 1, taken | {k}, links + 1, saved + cost[i][k])

    explore(0, frozenset(), 0, 0.0)
    return best[0][0]


def main():
    options = {**fleet.DEFAULTS, "depot": 0}

    chain = small([(0, 1, 0, 60), (1, 0, 70, 130), (0, 1, 140, 200)])
    plan = fleet.solve_cpu(chain, depot=0)
    check("one bus can run trips that connect, back and forth", plan["fleet"] == 1)
    check("a plan with no problems passes its own check", fleet.check(chain, plan) == [])

    overlap = small([(0, 1, 0, 60), (0, 1, 10, 70), (0, 1, 20, 80)])
    check("trips under way together need a bus each", fleet.solve_cpu(overlap, depot=0)["fleet"] == 3)

    far = small([(0, 1, 0, 60), (2, 2, 62, 100)])
    check("a bus cannot teleport between terminals", fleet.solve_cpu(far, depot=0)["fleet"] == 2)

    tight = small([(0, 1, 0, 60), (1, 0, 63, 120)])
    check("the layover is respected", fleet.solve_cpu(tight, depot=0)["fleet"] == 2)
    relaxed = fleet.solve_cpu(tight, depot=0, layover=1.0)
    check("a shorter layover lets one bus do both", relaxed["fleet"] == 1)

    broken = copy.deepcopy(plan)
    broken["vehicles"][0]["trips"] = broken["vehicles"][0]["trips"][:-1]
    check("a trip left out is caught", any("covered 0 times" in p for p in fleet.check(chain, broken)))
    twice = copy.deepcopy(plan)
    twice["vehicles"][0]["trips"] = twice["vehicles"][0]["trips"] + [twice["vehicles"][0]["trips"][0]]
    check("a trip run twice is caught", bool(fleet.check(chain, twice)))
    swapped = copy.deepcopy(plan)
    swapped["vehicles"][0]["trips"] = list(reversed(swapped["vehicles"][0]["trips"]))
    check("an impossible link is caught", any("needs until" in p for p in fleet.check(chain, swapped)))

    rng = random.Random(7)
    for case in range(12):
        trips = []
        for _ in range(7):
            a, b = rng.randrange(3), rng.randrange(3)
            start = rng.randrange(0, 240, 5)
            trips.append((a, b, start, start + rng.randrange(25, 70, 5)))
        data = small(trips)
        got = fleet.solve_cpu(data, depot=1)
        check(f"random case {case}: fleet matches brute force", got["fleet"] == brute_force(data, {**options, "depot": 1}))
        check(f"random case {case}: plan passes its check", fleet.check(data, got) == [])

    real = fleet.load()
    plan = fleet.solve_cpu(real)
    check("real data: every trip is covered once, no impossible link", fleet.check(real, plan) == [])
    check("real data: the fleet is at least the peak of trips under way", plan["fleet"] >= plan["peak"])
    check("real data: 351 trips of lines 19 and 36", plan["trips"] == 351 and real["withdrawn"] == ["19", "36"])
    check("real data: two vehicles never share a trip", len({t for v in plan["vehicles"] for t in v["trips"]}) == 351)
    other = fleet.solve_cpu(real, layover=15.0)
    check("a longer layover never needs fewer buses", other["fleet"] >= plan["fleet"])
    slow = fleet.solve_cpu(real, deadhead_kmh=10.0)
    check("slower empty running never needs fewer buses", slow["fleet"] >= plan["fleet"])

    auto = fleet.solve(real)
    check("auto returns a checked plan", fleet.check(real, auto) == [] and auto["fleet"] <= plan["fleet"])
    check("auto says why when it falls back to the CPU", auto["backend"] == "cuopt" or bool(auto["note"]))
    check("every trip appears once in the report", sorted(t for v in auto["vehicles"] for t in v["trips"]) == sorted(t["id"] for t in real["trips"]))
    print("fleet", auto["backend"], auto["fleet"], "buses for", auto["trips"], "trips")


if __name__ == "__main__":
    main()
