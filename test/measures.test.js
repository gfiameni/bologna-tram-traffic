import {
  airBand,
  centroid,
  changeTrend,
  levelBand,
  measureDiameter,
  noiseDb,
  percentChange,
  pickAnchors,
  spreadBoxes,
} from "../src/measures.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

check("a centroid sits on the average of the points", centroid([{ lat: 0, lon: 0 }, { lat: 2, lon: 4 }]).lat === 1);
check("a larger measure draws a larger bubble", measureDiameter(80, 100) > measureDiameter(20, 100));
check("heavy traffic is the peak band", levelBand(0.8) === "peak");
check("light traffic is the low band", levelBand(0.2) === "low");
check("a traffic station is the high air band", airBand(23) === "air-high");
check("a suburban station is the low air band", airBand(12) === "air-low");
check("a drop from 0.57 to 0.18 is about -68%", percentChange(0.57, 0.18) === -68);
check("halving car volume is about -3 dB", Math.abs(noiseDb(0.6, 0.3) + 3) < 0.1);
check("a small change counts as the same", changeTrend(0.2, 0.5) === "same" && changeTrend(-3, 0.5) === "less");

const line = Array.from({ length: 11 }, (_, index) => ({ lat: 44.5, lon: 11.3 + index * 0.01 }));
const anchors = pickAnchors([
  { id: "centre", samples: [{ lat: 44.5, lon: 11.3 }] },
  { id: "east", line: true, samples: line },
]);
check("a line anchor sits on its own streets", line.some((point) => point.lon === anchors.east.lon));
check("a line anchor keeps away from the centre", anchors.east.lon > 11.33);

const boxes = spreadBoxes([{ x: 100, y: 100, w: 80, h: 30 }, { x: 110, y: 104, w: 80, h: 30 }]);
const apart = Math.abs(boxes[0].x - boxes[1].x) >= 80 || Math.abs(boxes[0].y - boxes[1].y) >= 30;
check("overlapping labels are pushed apart", apart);
const [free] = spreadBoxes([{ x: 50, y: 50, w: 40, h: 20 }], [{ x: 50, y: 50, w: 40, h: 20 }]);
check("a label moves off a fixed bubble", Math.abs(free.x - 50) >= 40 || Math.abs(free.y - 50) >= 20);
