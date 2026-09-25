"""Where the kernels run.

Warp compiles the same kernels to CUDA when a CUDA device is present.
"""


def describe():
    try:
        import warp as wp

        wp.config.quiet = True
        names = [str(device) for device in wp.get_devices()]
        cuda = any(name.startswith("cuda") for name in names)
        return {
            "backend": "warp",
            "device": "cuda:0" if cuda else "cpu",
            "cuda": cuda,
            "warp": wp.__version__,
            "devices": names,
        }
    except ImportError:
        return {"backend": "numpy", "device": "cpu", "cuda": False, "warp": None, "devices": []}


def warp_device():
    info = describe()
    if info["backend"] != "warp":
        return None
    return info["device"]
