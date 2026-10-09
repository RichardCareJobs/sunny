"""Shared helpers for the sun pipeline: city config, paths, local projection."""
import json
import math
import os

HERE = os.path.dirname(os.path.abspath(__file__))
ALGORITHM_VERSION = "horizon-v1"  # keep in step with js/sun-core.js


def load_city(name):
    with open(os.path.join(HERE, "cities", f"{name}.json")) as f:
        return json.load(f)


def city_data_dir(name):
    d = os.path.join(HERE, "data", name)
    os.makedirs(d, exist_ok=True)
    return d


class LocalProjection:
    """Equirectangular metres around a city origin. Error < 0.1% over ~20 km,
    which is far below OSM footprint accuracy."""

    R = 6371008.8

    def __init__(self, lat0, lon0):
        self.lat0 = lat0
        self.lon0 = lon0
        self.kx = math.cos(math.radians(lat0)) * math.pi / 180 * self.R
        self.ky = math.pi / 180 * self.R

    def fwd(self, lon, lat):
        return ((lon - self.lon0) * self.kx, (lat - self.lat0) * self.ky)

    def inv(self, x, y):
        return (self.lon0 + x / self.kx, self.lat0 + y / self.ky)
