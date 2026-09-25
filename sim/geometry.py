import math


def hav(a, b):
    lon1, lat1 = a
    lon2, lat2 = b
    radius = 6371000.0
    p1, p2 = math.radians(lat1), math.radians(lat2)
    dp = math.radians(lat2 - lat1)
    dl = math.radians(lon2 - lon1)
    h = math.sin(dp / 2) ** 2 + math.cos(p1) * math.cos(p2) * math.sin(dl / 2) ** 2
    return 2 * radius * math.asin(min(1.0, math.sqrt(h)))


def polyline_length(coords):
    return sum(hav(a, b) for a, b in zip(coords, coords[1:]))
