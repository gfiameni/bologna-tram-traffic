"""Run one of the corridor models."""

from sim import bpr, ctm, idm, surrogate
from sim.design import merge

MODELS = {
    "bpr": "Volume-delay with signals",
    "ctm": "Cell transmission",
    "idm": "Car following",
    "surrogate": "Neural surrogate of the cell model",
}


def run(name, corridor, scenario, shift, headway, use_warp=False, hour=8, design=None, year=None):
    """`year` picks the measured demand ("before" 2024, "after" 2026); it follows the scenario by default."""
    corridor = corridor.for_year(year or scenario)
    design = merge(design)
    if name == "bpr":
        return bpr.run(corridor, scenario, shift, headway, hour=hour, design=design)
    if name == "ctm":
        return ctm.run(corridor, scenario, shift, headway, use_warp=use_warp, hour=hour, design=design)
    if name == "idm":
        return idm.run(corridor, scenario, shift, headway, use_warp=use_warp, hour=hour, design=design)
    if name == "surrogate":
        return surrogate.run(corridor, scenario, shift, headway, hour=hour, design=design)
    raise KeyError(name)
