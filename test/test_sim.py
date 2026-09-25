"""Checks for the corridor models. Run with the project virtualenv."""

import numpy as np

from sim import kernels
from sim.ctm import _rollout, horizon
from sim.models import run
from sim.supply import load
from sim.surrogate import train


def check(name, ok):
    print(("ok  " if ok else "FAIL") + " " + name)
    if not ok:
        raise SystemExit(1)


def main():
    corridor = load()
    seconds, flow = _rollout(900, 2, 0.2, [], 12.5, horizon(900), False)
    check("free-flow demand gets through", 650 < flow < 780)
    check("free-flow time stays near the speed limit", seconds < 900 / 12.5 * 1.35)

    choked_s, choked_q = _rollout(900, 1, 0.8, [200, 500], 12.5, horizon(900), False)
    check("a red signal lets fewer vehicles through", choked_q < 500)
    check("the signal adds delay", choked_s > 900 / 12.5)

    density = np.zeros(6)
    scale = np.array([1, 0, 1, 1, 0, 1], dtype=float)
    warp = None
    for _ in range(6):
        warp = kernels.ctm_step(density, scale, 0.5, 0.26, 12.5, 5.0, 50.0, 1.0, 0.2)
        qmax, kj, free, wave, dx, dt, inflow = 0.5, 0.26, 12.5, 5.0, 50.0, 1.0, 0.2
        send = np.minimum(free * density, qmax) * scale
        receive = np.minimum(wave * np.maximum(kj - density, 0.0), qmax) * scale
        flow_in = np.empty(6)
        flow_in[0] = min(inflow, receive[0])
        flow_in[1:] = np.minimum(send[:-1], receive[1:])
        flow_out = np.empty(6)
        flow_out[:-1] = flow_in[1:]
        flow_out[-1] = send[-1]
        density = np.maximum(0.0, density + dt / dx * (flow_in - flow_out))
    check("Warp cell update matches NumPy", warp is not None and np.max(np.abs(density - warp)) < 1e-5)

    pos = np.array([0, 12, 30], dtype=float)
    vel = np.array([10, 8, 6], dtype=float)
    lead_pos = np.array([12, 30, 90], dtype=float)
    lead_vel = np.array([8, 6, 6], dtype=float)
    desired = np.array([14, 14, 14], dtype=float)
    veh_len = np.array([5, 5, 5], dtype=float)
    device_accel = kernels.idm_accelerations(pos, vel, lead_pos, lead_vel, desired, veh_len, 1.2, 2.0, 1.2, 2.0)
    gap = np.maximum(0.4, lead_pos - pos - veh_len)
    closing = vel - lead_vel
    star = np.maximum(2.0, 2.0 + vel * 1.2 + vel * closing / (2.0 * np.sqrt(1.2 * 2.0) + 1e-4))
    ratio = vel / desired
    numpy_accel = 1.2 * (1.0 - ratio ** 4 - (star / gap) ** 2)
    check("Warp car-following matches NumPy", device_accel is not None and np.max(np.abs(device_accel - numpy_accel)) < 1e-4)

    before = run("ctm", corridor, "before", 0.0, 4.5)
    after = run("ctm", corridor, "after", 0.0, 4.5)
    check("giving a lane to the tram cuts car throughput", after["carFlow"] < before["carFlow"] * 0.75)
    check("cell model keeps a positive flow", before["carFlow"] > 100)

    bpr_before = run("bpr", corridor, "before", 0.0, 4.5)
    bpr_after = run("bpr", corridor, "after", 0.0, 4.5)
    evening = run("bpr", corridor, "before", 0.0, 4.5, hour=21)
    check("21:00 has lighter car demand than the morning peak", evening["carFlow"] < bpr_before["carFlow"] * 0.7)
    check("volume-delay slows Via Emilia when a lane goes", bpr_after["viaEmiliaKmh"] < bpr_before["viaEmiliaKmh"])

    weights = train(corridor)
    check("surrogate holdout stays within a few minutes", weights["holdoutMinutesMae"] < 4)

    tram = run("bpr", corridor, "after", 0.25, 4.5)
    check("tram to the Fiera is in the published band", 30 < tram["transitFieraMin"] < 50)
    print("holdout MAE", weights["holdoutMinutesMae"], "min")
    print("ctm cars/h", round(before["carFlow"]), "->", round(after["carFlow"]))


if __name__ == "__main__":
    main()
