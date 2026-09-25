"""A small neural net trained on the cell-transmission model.

It is a corridor surrogate: seven inputs describe a street, two outputs are
travel time and how much of the demand gets through. Weights are fit here,
in NumPy, from CTM runs. This is not a forecast model and not PhysicsNeMo.
"""

import json

import numpy as np

from sim.ctm import _rollout, horizon
from sim.engine import bike_trip, bus_trip, chain_time, demand, people_and_transit, tram_minutes

_WEIGHTS = None


def _features(car_h, bike_h, bus_h, lanes, signals, length, protected):
    return np.array([
        car_h / 2500.0,
        bike_h / 300.0,
        bus_h / 20.0,
        lanes / 2.0,
        len(signals) / 12.0,
        length / 6000.0,
        1.0 if protected else 0.0,
    ], dtype=np.float64)


def _collect(corridor):
    rows = []
    targets = []
    for piece in corridor.pieces.values():
        for lanes in (1, 2):
            for scale in (0.55, 0.85, 1.0, 1.25, 1.6):
                car = corridor.car_per_hour * scale
                bus = corridor.bus_per_hour * (0.0 if piece.name == "bypass" else scale)
                bike = corridor.bike_per_hour * scale
                pce = car + 2.2 * bus + (0.0 if piece.bike_protected else 0.3 * bike)
                seconds, throughput = _rollout(piece.length, lanes, pce / 3600.0, piece.signals, piece.free, horizon(piece.length), False)
                rows.append(_features(car, bike, bus, lanes, piece.signals, piece.length, piece.bike_protected))
                targets.append([
                    seconds / 60.0,
                    min(1.2, throughput / max(1.0, pce)),
                ])
    return np.vstack(rows), np.vstack(targets)


def train(corridor, seed=7):
    features, targets = _collect(corridor)
    mean = features.mean(axis=0)
    std = np.maximum(features.std(axis=0), 1e-3)
    y_mean = targets.mean(axis=0)
    y_std = np.maximum(targets.std(axis=0), 1e-3)
    x = (features - mean) / std
    y = (targets - y_mean) / y_std
    rng = np.random.default_rng(seed)
    hold = rng.choice(len(x), size=max(4, len(x) // 5), replace=False)
    train_mask = np.ones(len(x), dtype=bool)
    train_mask[hold] = False
    w1 = rng.normal(0, 0.35, (x.shape[1], 12))
    b1 = np.zeros(12)
    w2 = rng.normal(0, 0.35, (12, 2))
    b2 = np.zeros(2)
    rate = 0.04
    xt, yt = x[train_mask], y[train_mask]
    for _epoch in range(700):
        hidden = np.tanh(xt @ w1 + b1)
        pred = hidden @ w2 + b2
        error = pred - yt
        grad_w2 = hidden.T @ error / len(xt)
        grad_b2 = error.mean(axis=0)
        back = (error @ w2.T) * (1 - hidden ** 2)
        w2 -= rate * grad_w2
        b2 -= rate * grad_b2
        w1 -= rate * (xt.T @ back / len(xt))
        b1 -= rate * back.mean(axis=0)
    hidden = np.tanh(x[hold] @ w1 + b1)
    pred = (hidden @ w2 + b2) * y_std + y_mean
    actual = targets[hold]
    mae = float(np.mean(np.abs(pred[:, 0] - actual[:, 0])))
    weights = {
        "mean": mean.tolist(),
        "std": std.tolist(),
        "yMean": y_mean.tolist(),
        "yStd": y_std.tolist(),
        "w1": w1.tolist(),
        "b1": b1.tolist(),
        "w2": w2.tolist(),
        "b2": b2.tolist(),
        "holdoutMinutesMae": round(mae, 3),
        "samples": int(len(x)),
    }
    global _WEIGHTS
    _WEIGHTS = weights
    return weights


def load_weights(weights):
    global _WEIGHTS
    _WEIGHTS = weights


def _predict(features):
    weights = _WEIGHTS
    x = (features - np.array(weights["mean"])) / np.array(weights["std"])
    hidden = np.tanh(x @ np.array(weights["w1"]) + np.array(weights["b1"]))
    pred = hidden @ np.array(weights["w2"]) + np.array(weights["b2"])
    return pred * np.array(weights["yStd"]) + np.array(weights["yMean"])


def _piece(piece, car_h, bus_h, bike_h, scenario):
    lanes = 1 if scenario == "after" and piece.affected else 2
    bus = bus_h if piece.name != "bypass" else 0.0
    minutes, ratio = _predict(_features(car_h, bike_h, bus, lanes, piece.signals, piece.length, piece.bike_protected))
    minutes = max(piece.length / piece.free / 60.0, float(minutes))
    pce = car_h + 2.2 * bus + (0.0 if piece.bike_protected else 0.3 * bike_h)
    throughput = max(0.0, min(pce, pce * float(ratio)))
    car_share = car_h / max(1.0, pce)
    car_out = throughput * car_share
    bike_out = bike_h if piece.bike_protected else throughput * (bike_h / max(1.0, pce))
    car_mps = piece.length / (minutes * 60.0)
    bike_mps = 5.6 if piece.bike_protected else min(4.6, car_mps * 0.9)
    return {
        "car_min": minutes,
        "bus_min": minutes + (20 * len(piece.stops)) / 60.0,
        "bike_min": (piece.length / bike_mps) / 60.0,
        "car_mps": car_mps,
        "bike_mps": bike_mps,
        "car_out": car_out,
        "bike_out": bike_out,
    }


def run(corridor, scenario, shift, headway, hour=8):
    if _WEIGHTS is None:
        train(corridor)
    car_h, bus_h, bike_h = demand(corridor, scenario, shift, hour)
    stats = {}
    upstream = car_h
    for name in ("trunk", "bypass", "city"):
        stats[name] = _piece(corridor.piece(name), upstream, bus_h, bike_h, scenario)
        upstream = stats[name]["car_out"]
    for name, share in (("fiera", 0.56), ("pilastro", 0.44)):
        stats[name] = _piece(corridor.piece(name), upstream * share, bus_h * share, bike_h * share, scenario)
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


def save(weights, path):
    path.write_text(json.dumps(weights))
