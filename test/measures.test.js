import { airBand, measureDiameter, spreadBoxes, tipSide } from "../src/measures.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

check("a larger measure draws a larger bubble", measureDiameter(80, 100) > measureDiameter(20, 100));
check("a traffic station is the high air band", airBand(23) === "air-high");
check("a suburban station is the low air band", airBand(12) === "air-low");

const boxes = spreadBoxes([{ x: 100, y: 100, w: 80, h: 30 }, { x: 110, y: 104, w: 80, h: 30 }]);
const apart = Math.abs(boxes[0].x - boxes[1].x) >= 80 || Math.abs(boxes[0].y - boxes[1].y) >= 30;
check("overlapping labels are pushed apart", apart);
const [free] = spreadBoxes([{ x: 50, y: 50, w: 40, h: 20 }], [{ x: 50, y: 50, w: 40, h: 20 }]);
check("a label moves off a fixed bubble", Math.abs(free.x - 50) >= 40 || Math.abs(free.y - 50) >= 20);

const area = { left: 300, top: 0, right: 900, bottom: 600 };
const [shown] = spreadBoxes([{ x: 280, y: 100, w: 120, h: 40 }], [], { area });
check("a label under the side panel moves into the map", shown.x - shown.w / 2 >= area.left);
const pair = spreadBoxes([{ x: 300, y: 300, w: 120, h: 40 }, { x: 310, y: 305, w: 120, h: 40 }], [], { area });
const inside = pair.every((box) => box.x - box.w / 2 >= area.left && box.x + box.w / 2 <= area.right);
const separate = Math.abs(pair[0].x - pair[1].x) >= 120 || Math.abs(pair[0].y - pair[1].y) >= 40;
check("labels pushed apart stay inside the map", inside && separate);

check("a tooltip in the middle of the map opens above", tipSide({ x: 600, y: 300 }, area, 20).direction === "top");
check("a tooltip above a bubble clears the bubble", tipSide({ x: 600, y: 300 }, area, 20).offset[1] === -20);
check("a tooltip near the left panel opens to the right", tipSide({ x: 360, y: 300 }, area, 20).direction === "right");
check("a tooltip near the right panel opens to the left", tipSide({ x: 850, y: 300 }, area, 20).direction === "left");
check("a tooltip near the top opens below", tipSide({ x: 600, y: 40 }, area, 20).direction === "bottom");
check("without an area a tooltip opens above", tipSide({ x: 10, y: 10 }, null).direction === "top");
