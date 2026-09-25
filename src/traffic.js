/** Animated vehicles. Speeds come from whichever model is selected. */

const CAR_PIECES = ["trunk", "bypass", "city", "fiera", "pilastro"];

function geometryMode(mode) {
  return mode === "car" ? "car" : "tram";
}

function chainFor(mode, branch) {
  return mode === "car" ? ["trunk", "bypass", "city", branch] : ["trunk", branch];
}

export function createTraffic(geo) {
  const worlds = {
    before: { vehicles: [], acc: {} },
    after: { vehicles: [], acc: {} },
  };
  let nextId = 1;

  function add(world, vehicle) {
    if (world.vehicles.length > 2800) return;
    world.vehicles.push({ id: nextId++, dwell: 0, ...vehicle });
  }

  function speedOf(vehicle, spec, params) {
    if (vehicle.mode === "tram") return params.tramSpeedMps;
    if (vehicle.mode === "bike") {
      const speeds = spec.bikeSpeeds || {};
      return speeds[vehicle.piece] || speeds.trunk || 5;
    }
    if (vehicle.mode === "car") return spec.speeds[vehicle.piece];
    if (vehicle.piece === "trunk") {
      const tail = geo.lengths.tram.trunk - geo.lengths.car.city;
      if (vehicle.s < geo.screenS) return spec.speeds.trunk;
      if (vehicle.s > tail) return spec.speeds.city;
      return params.centerSpeedMps;
    }
    return spec.speeds[vehicle.piece] ?? params.centerSpeedMps;
  }

  function seedScenario(scenario, params, spec) {
    const world = worlds[scenario];
    world.vehicles = [];
    world.acc = {};
    const share = { fiera: params.fieraShare, pilastro: 1 - params.fieraShare };

    for (const piece of CAR_PIECES) {
      const flow = piece === "fiera" || piece === "pilastro" ? spec.carFlow * share[piece] : spec.carFlow;
      const speed = spec.speeds[piece];
      const count = Math.min(420, Math.round((flow / 3600) * (geo.lengths.car[piece] / speed)));
      for (const dir of [1, -1]) {
        for (let i = 0; i < count; i++) {
          const branch = piece === "fiera" || piece === "pilastro"
            ? piece
            : Math.random() < params.fieraShare ? "fiera" : "pilastro";
          add(world, {
            scenario,
            mode: "car",
            dir,
            branch,
            piece,
            s: Math.random() * geo.lengths.car[piece],
          });
        }
      }
    }

    const transitMode = spec.transit;
    for (const branch of ["fiera", "pilastro"]) {
      for (const dir of [1, -1]) {
        seedEven(world, scenario, transitMode, branch, spec.vehiclesPerHour * share[branch], spec, params, dir);
        const bikeFlow = (spec.bikeFlow || 0) * share[branch] * (dir > 0 ? 1 : 0.65);
        seedEven(world, scenario, "bike", branch, bikeFlow, spec, params, dir);
      }
    }
  }

  function seedEven(world, scenario, mode, branch, perHour, spec, params, dir) {
    if (perHour < 0.2) return;
    const spacing = 3600 / perHour;
    const pieces = chainFor(mode, branch);
    let cursor = (dir > 0 ? 0.2 : 0.5) * spacing;
    let guard = 0;
    while (guard++ < 80) {
      let remaining = cursor;
      let placed = false;
      for (const piece of pieces) {
        const poly = geo.pieces[geometryMode(mode)][piece];
        const probe = { mode, piece, s: poly.length / 2, dir, branch };
        const speed = Math.max(1.5, speedOf(probe, spec, params));
        const duration = poly.length / speed;
        if (remaining <= duration) {
          add(world, {
            scenario,
            mode,
            dir,
            branch,
            piece,
            s: remaining * speed,
          });
          placed = true;
          break;
        }
        remaining -= duration;
      }
      if (!placed) break;
      cursor += spacing;
    }
  }

  function take(world, key, perHour, dt) {
    world.acc[key] = (world.acc[key] || 0) + (perHour / 3600) * dt;
    let count = 0;
    while (world.acc[key] >= 1 && count < 6) {
      world.acc[key] -= 1;
      count++;
    }
    return count;
  }

  function move(vehicle, spec, params, dt) {
    if (vehicle.dwell > 0) {
      vehicle.dwell -= dt;
      return true;
    }
    const mode = geometryMode(vehicle.mode);
    const poly = geo.pieces[mode][vehicle.piece];
    const speed = speedOf(vehicle, spec, params);
    const next = vehicle.s + vehicle.dir * speed * dt;
    if (vehicle.mode === "bus" || vehicle.mode === "tram") {
      const stops = geo.stops[vehicle.piece] || [];
      for (const stopS of stops) {
        if (stopS < 45 || stopS > poly.length - 45) continue;
        const crossed = vehicle.dir > 0
          ? vehicle.s < stopS && next >= stopS
          : vehicle.s > stopS && next <= stopS;
        if (crossed) {
          vehicle.s = stopS;
          vehicle.dwell = params.dwellSec;
          return true;
        }
      }
    }
    vehicle.s = next;
    if (vehicle.dir > 0 && vehicle.s >= poly.length) {
      const chain = chainFor(vehicle.mode, vehicle.branch);
      const index = chain.indexOf(vehicle.piece);
      if (index < 0 || index === chain.length - 1) return false;
      vehicle.piece = chain[index + 1];
      vehicle.s = 0;
    } else if (vehicle.dir < 0 && vehicle.s <= 0) {
      const chain = chainFor(vehicle.mode, vehicle.branch);
      const index = chain.indexOf(vehicle.piece);
      if (index <= 0) return false;
      vehicle.piece = chain[index - 1];
      vehicle.s = geo.pieces[mode][vehicle.piece].length;
    }
    return true;
  }

  return {
    seed(params, result) {
      seedScenario("before", params, result.before);
      seedScenario("after", params, result.after);
    },
    step(dt, params, result) {
      for (const scenario of ["before", "after"]) {
        const world = worlds[scenario];
        const spec = result[scenario];
        const share = { fiera: params.fieraShare, pilastro: 1 - params.fieraShare };
        const eastCars = take(world, "car-east", spec.carFlow, dt);
        for (let i = 0; i < eastCars; i++) {
          add(world, {
            scenario,
            mode: "car",
            dir: 1,
            branch: Math.random() < params.fieraShare ? "fiera" : "pilastro",
            piece: "trunk",
            s: 0,
          });
        }
        for (const branch of ["fiera", "pilastro"]) {
          const westCars = take(world, `car-west-${branch}`, spec.carFlow * share[branch], dt);
          for (let i = 0; i < westCars; i++) {
            add(world, {
              scenario,
              mode: "car",
              dir: -1,
              branch,
              piece: branch,
              s: geo.lengths.car[branch],
            });
          }
          const perHour = spec.vehiclesPerHour * share[branch];
          const mode = spec.transit;
          const eastTransit = take(world, `${mode}-east-${branch}`, perHour, dt);
          for (let i = 0; i < eastTransit; i++) {
            add(world, { scenario, mode, dir: 1, branch, piece: "trunk", s: 0 });
          }
          const westTransit = take(world, `${mode}-west-${branch}`, perHour, dt);
          for (let i = 0; i < westTransit; i++) {
            add(world, {
              scenario,
              mode,
              dir: -1,
              branch,
              piece: branch,
              s: geo.pieces.tram[branch].length,
            });
          }
          const bikeShare = (spec.bikeFlow || 0) * share[branch];
          const eastBikes = take(world, `bike-east-${branch}`, bikeShare, dt);
          for (let i = 0; i < eastBikes; i++) {
            add(world, { scenario, mode: "bike", dir: 1, branch, piece: "trunk", s: 0 });
          }
          const westBikes = take(world, `bike-west-${branch}`, bikeShare * 0.65, dt);
          for (let i = 0; i < westBikes; i++) {
            add(world, {
              scenario,
              mode: "bike",
              dir: -1,
              branch,
              piece: branch,
              s: geo.pieces.tram[branch].length,
            });
          }
        }
        world.vehicles = world.vehicles.filter((vehicle) => move(vehicle, spec, params, dt));
      }
    },
    vehicles(scenario) {
      return worlds[scenario].vehicles;
    },
    locate(vehicle) {
      const poly = geo.pieces[geometryMode(vehicle.mode)][vehicle.piece];
      const s = Math.max(0, Math.min(poly.length, vehicle.s));
      let index = Math.min(
        poly.points.length - 2,
        Math.max(0, Math.floor((s / poly.length) * (poly.points.length - 1))),
      );
      while (index > 0 && poly.points[index].s > s) index--;
      while (index < poly.points.length - 2 && poly.points[index + 1].s < s) index++;
      const a = poly.points[index];
      const b = poly.points[Math.min(poly.points.length - 1, index + 1)];
      const span = b.s - a.s || 1;
      const t = Math.max(0, Math.min(1, (s - a.s) / span));
      return {
        lat: a.lat + (b.lat - a.lat) * t,
        lon: a.lon + (b.lon - a.lon) * t,
        lat2: b.lat,
        lon2: b.lon,
      };
    },
  };
}
