"""Run one of the corridor models."""

from sim import bpr, ctm, idm, surrogate

MODELS = {
    "bpr": "Volume-delay with signals",
    "ctm": "Cell transmission",
    "idm": "Car following",
    "surrogate": "Neural surrogate of the cell model",
}


def run(name, corridor, scenario, shift, headway, use_warp=False, hour=8):
    if name == "bpr":
        return bpr.run(corridor, scenario, shift, headway, hour=hour)
    if name == "ctm":
        return ctm.run(corridor, scenario, shift, headway, use_warp=use_warp, hour=hour)
    if name == "idm":
        return idm.run(corridor, scenario, shift, headway, use_warp=use_warp, hour=hour)
    if name == "surrogate":
        return surrogate.run(corridor, scenario, shift, headway, hour=hour)
    raise KeyError(name)
