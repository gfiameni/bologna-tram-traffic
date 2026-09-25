"""Warp kernels. On an NVIDIA GPU these compile to CUDA; on this Mac, to CPU."""

import numpy as np

from sim.device import warp_device

_DEVICE = warp_device()
_WP = None
if _DEVICE is not None:
    import warp as wp

    wp.config.quiet = True
    wp.init()
    _WP = wp

    @wp.kernel
    def idm_accel(
        pos: wp.array(dtype=wp.float32),
        vel: wp.array(dtype=wp.float32),
        lead_pos: wp.array(dtype=wp.float32),
        lead_vel: wp.array(dtype=wp.float32),
        v0: wp.array(dtype=wp.float32),
        veh_len: wp.array(dtype=wp.float32),
        out: wp.array(dtype=wp.float32),
        accel: wp.float32,
        brake: wp.float32,
        time_headway: wp.float32,
        s0: wp.float32,
    ):
        i = wp.tid()
        speed = vel[i]
        gap = wp.max(0.4, lead_pos[i] - pos[i] - veh_len[i])
        closing = speed - lead_vel[i]
        desired = s0 + speed * time_headway + speed * closing / (2.0 * wp.sqrt(accel * brake) + 1.0e-4)
        desired = wp.max(s0, desired)
        ratio = speed / wp.max(v0[i], 0.1)
        squared = ratio * ratio
        free = squared * squared
        interaction = (desired / gap) * (desired / gap)
        out[i] = accel * (1.0 - free - interaction)

    @wp.kernel
    def ctm_update(
        k_old: wp.array(dtype=wp.float32),
        k_new: wp.array(dtype=wp.float32),
        supply_scale: wp.array(dtype=wp.float32),
        qmax: wp.float32,
        kj: wp.float32,
        vf: wp.float32,
        wave: wp.float32,
        dx: wp.float32,
        dt: wp.float32,
        demand: wp.float32,
        n: wp.int32,
    ):
        i = wp.tid()
        send_i = wp.min(vf * k_old[i], qmax) * supply_scale[i]
        if i == n - 1:
            flow_out = send_i
        else:
            receive = wp.min(wave * wp.max(0.0, kj - k_old[i + 1]), qmax) * supply_scale[i + 1]
            flow_out = wp.min(send_i, receive)
        if i == 0:
            receive0 = wp.min(wave * wp.max(0.0, kj - k_old[0]), qmax) * supply_scale[0]
            flow_in = wp.min(demand, receive0)
        else:
            send_prev = wp.min(vf * k_old[i - 1], qmax) * supply_scale[i - 1]
            receive_i = wp.min(wave * wp.max(0.0, kj - k_old[i]), qmax) * supply_scale[i]
            flow_in = wp.min(send_prev, receive_i)
        k_new[i] = wp.max(0.0, k_old[i] + dt / dx * (flow_in - flow_out))


def available():
    return _WP is not None


def idm_accelerations(pos, vel, lead_pos, lead_vel, v0, veh_len, accel, brake, headway, s0):
    """GPU/CPU kernel for the Intelligent Driver Model acceleration."""
    if _WP is None or len(pos) == 0:
        return None
    out = np.empty(len(pos), dtype=np.float32)
    arrays = [
        _WP.array(np.ascontiguousarray(value, dtype=np.float32), dtype=_WP.float32, device=_DEVICE)
        for value in (pos, vel, lead_pos, lead_vel, v0, veh_len, out)
    ]
    _WP.launch(
        idm_accel,
        dim=len(pos),
        inputs=[*arrays, float(accel), float(brake), float(headway), float(s0)],
        device=_DEVICE,
    )
    _WP.synchronize()
    return arrays[-1].numpy()


def ctm_step(density, supply_scale, qmax, kj, vf, wave, dx, dt, demand):
    if _WP is None:
        return None
    n = len(density)
    old = _WP.array(np.ascontiguousarray(density, dtype=np.float32), dtype=_WP.float32, device=_DEVICE)
    new = _WP.zeros(n, dtype=_WP.float32, device=_DEVICE)
    scale = _WP.array(np.ascontiguousarray(supply_scale, dtype=np.float32), dtype=_WP.float32, device=_DEVICE)
    _WP.launch(
        ctm_update,
        dim=n,
        inputs=[old, new, scale, float(qmax), float(kj), float(vf), float(wave), float(dx), float(dt), float(demand), int(n)],
        device=_DEVICE,
    )
    _WP.synchronize()
    return new.numpy()
