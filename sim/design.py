"""Street layout and signal plan for each piece of the car route.

Before is the 2024 baseline street: two-way, 90 second cycle, 50 seconds of green, no
coordination between junctions. That plan lets the baseline streets carry the
counted 1,155 cars an hour at 08:00. After is the tram design the user sets:
width, direction, cycle, green, green wave, and whether trams get priority.
"""

import math

PIECES = ("trunk", "bypass", "city", "fiera", "pilastro")
LANE_M = 3.25
TRACK_M = 6.5
DEFAULT_WIDTH_M = 13.0
# The bypass runs on the viali, wide enough for three lanes each way.
WIDTH_M = {"bypass": 20.0}
SATURATION_PER_LANE = 1800.0
TODAY_CYCLE_S = 90.0
TODAY_GREEN_S = 50.0
# Cross streets keep at least this much of each cycle: their green plus the change intervals.
CROSS_MIN_S = 30.0
TRAM_HOLD_S = 18.0
MAX_GREEN_LOST = 0.65
WAVE_MPS = 30 / 3.6
WAVE_PROGRESSION = 0.7
JUNCTION_M = 60.0
MEASURE_S = 240.0
# Viale Pietramellara at 08:00: 868 cars/h west against 1,150 north-east.
COUNTER_SHARE = 0.75


def default_design():
    return {
        "priority": True,
        "streets": {
            name: {
                "width": WIDTH_M.get(name, DEFAULT_WIDTH_M),
                "oneWay": False,
                "cycle": TODAY_CYCLE_S,
                "green": TODAY_GREEN_S,
                "wave": False,
            }
            for name in PIECES
        },
    }


def merge(design):
    """Fill missing keys from the default, so a partial design is valid."""
    base = default_design()
    if not design:
        return base
    base["priority"] = bool(design.get("priority", True))
    for name, street in (design.get("streets") or {}).items():
        if name in base["streets"] and street:
            base["streets"][name].update({key: value for key, value in street.items() if value is not None})
    return base


def street_layout(piece, scenario, street):
    """Car lanes in the modelled direction, and whether the street runs one-way."""
    width = float(street["width"])
    if scenario != "after":
        return {"lanes": max(1, math.floor(width / (2 * LANE_M) + 1e-9)), "oneWay": False, "forced": False}
    room = width - (TRACK_M if piece.affected else 0.0)
    two_way = math.floor(room / (2 * LANE_M) + 1e-9)
    one_way = bool(street["oneWay"]) or two_way < 1
    lanes = math.floor(room / LANE_M + 1e-9) if one_way else two_way
    return {"lanes": max(1, lanes), "oneWay": one_way, "forced": one_way and not street["oneWay"]}


def tram_passages(headway):
    return 2 * (60.0 / max(headway, 0.5))


def signal_plan(piece, scenario, street, priority, headway):
    """Cycle, green the cars actually get, and whether the lights run as a green wave."""
    if scenario != "after":
        return {"cycle": TODAY_CYCLE_S, "green": TODAY_GREEN_S, "carGreen": TODAY_GREEN_S, "wave": False, "tramWait": 0.0}
    cycle = float(street["cycle"])
    green = min(float(street["green"]), cycle - CROSS_MIN_S)
    car_green = green
    tram_wait = 0.0
    if piece.affected:
        if priority:
            green_per_hour = (green / cycle) * 3600.0
            lost = min(MAX_GREEN_LOST, tram_passages(headway) * TRAM_HOLD_S / max(green_per_hour, 1.0))
            car_green = green * (1.0 - lost)
        else:
            red = cycle - green
            tram_wait = red * red / (2.0 * cycle)
    return {"cycle": cycle, "green": green, "carGreen": car_green, "wave": bool(street["wave"]), "tramWait": tram_wait}


def junctions(signals):
    """Junction number of each signal. OSM puts a signal on each carriageway, so lights closer than 60 m are one junction."""
    groups = []
    first = []
    for position in signals:
        if not first or position - first[-1] >= JUNCTION_M:
            first.append(position)
        groups.append(len(first) - 1)
    return groups, first


def junction_count(signals):
    return len(junctions(signals)[1])


def measure_window(cycle):
    """Whole signal cycles covering at least four minutes, so a part-cycle never biases a count."""
    return cycle * math.ceil(MEASURE_S / cycle - 1e-9)


def capacity(layout, plan):
    """Cars an hour the lights let through in the modelled direction."""
    return layout["lanes"] * SATURATION_PER_LANE * plan["carGreen"] / plan["cycle"]


def offsets(signals, plan, model):
    """Seconds added to the clock at each signal. A green wave opens each light as a car at the limit arrives."""
    cycle = plan["cycle"]
    if plan["wave"]:
        return [(-position / WAVE_MPS) % cycle for position in signals]
    groups, first = junctions(signals)
    if model == "idm":
        return [(first[group] * 0.1) % cycle for group in groups]
    return [(group * 17) % cycle for group in groups]
