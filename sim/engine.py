"""Shared scenario accounting for every model."""

from dataclasses import dataclass


@dataclass
class Result:
    car_fiera: float
    car_pilastro: float
    bike_fiera: float
    transit_fiera: float
    transit_pilastro: float
    via_emilia: float
    people: float
    unserved: float
    speeds: dict
    bike_speeds: dict
    car_flow: float
    bike_flow: float
    transit: str
    vehicles_per_hour: float


def demand(corridor, scenario, shift):
    moved = shift if scenario == "after" else 0.0
    cars = corridor.car_per_hour * (1.0 - moved)
    buses = 0.0 if scenario == "after" else corridor.bus_per_hour
    return cars, buses, corridor.bike_per_hour


def chain_time(stats, branch, key):
    return stats["trunk"][key] + stats["bypass"][key] + stats["city"][key] + stats[branch][key]


def bike_trip(stats, branch, key, corridor):
    centre = corridor.centre_m / max(1.0, stats["trunk"]["bike_mps"]) / 60
    return stats["trunk"][key] + centre + stats["city"][key] + stats[branch][key]


def bus_trip(stats, branch, corridor):
    centre = corridor.centre_m / 6.2 / 60
    return stats["trunk"]["bus_min"] + centre + stats["city"]["bus_min"] + stats[branch]["bus_min"]


def tram_minutes(corridor, branch):
    length = corridor.tram_length["trunk"] + corridor.tram_length[branch]
    stops = max(0, corridor.tram_stops.get("trunk", 1) + corridor.tram_stops.get(branch, 1) - 2)
    return (length / 7.6 + stops * 26) / 60


def pack(result):
    return {
        "carFieraMin": result.car_fiera,
        "carPilastroMin": result.car_pilastro,
        "bikeFieraMin": result.bike_fiera,
        "transitFieraMin": result.transit_fiera,
        "transitPilastroMin": result.transit_pilastro,
        "viaEmiliaKmh": result.via_emilia,
        "peoplePerHour": result.people,
        "unserved": result.unserved,
        "speeds": result.speeds,
        "bikeSpeeds": result.bike_speeds,
        "carFlow": result.car_flow,
        "bikeFlow": result.bike_flow,
        "transit": result.transit,
        "vehiclesPerHour": result.vehicles_per_hour,
    }


def people_and_transit(corridor, scenario, shift, headway, trunk_cars, trunk_bikes, transit_fiera, transit_pilastro, speeds, bike_speeds, car_fiera, car_pilastro, bike_fiera):
    if scenario == "after":
        market = corridor.bus_per_hour * corridor.passengers_per_bus + corridor.car_per_hour * shift * corridor.occupancy
        capacity = (60.0 / headway) * 220.0
        transit = "tram"
        vehicles = 60.0 / headway
    else:
        market = corridor.bus_per_hour * corridor.passengers_per_bus
        capacity = corridor.bus_per_hour * 90.0
        transit = "bus"
        vehicles = corridor.bus_per_hour
    carried = min(market, capacity)
    return pack(Result(
        car_fiera=car_fiera,
        car_pilastro=car_pilastro,
        bike_fiera=bike_fiera,
        transit_fiera=transit_fiera,
        transit_pilastro=transit_pilastro,
        via_emilia=speeds["trunk"] * 3.6,
        people=trunk_cars * corridor.occupancy + trunk_bikes + carried,
        unserved=max(0.0, market - capacity),
        speeds=speeds,
        bike_speeds=bike_speeds,
        car_flow=trunk_cars,
        bike_flow=trunk_bikes,
        transit=transit,
        vehicles_per_hour=vehicles,
    ))
