import { approachHeat, queueChange, queueDiameter, queueShare } from "../src/queue.js";

function check(name, condition) {
  if (!condition) {
    console.error("FAIL", name);
    process.exitCode = 1;
  } else {
    console.log("ok", name);
  }
}

check("a longer queue draws a larger bubble", queueDiameter(900) > queueDiameter(200));
check("an empty queue still has a visible bubble", queueDiameter(0) >= 34);
check("bubble size is capped", queueDiameter(2000) === queueDiameter(1000));
check("a falling queue is marked as less", queueChange(700, 500) === "less");
check("a growing queue is marked as more", queueChange(700, 900) === "more");
check("an unchanged queue is marked as same", queueChange(700, 700) === "same");
check("queue share is the queued part of demand", queueShare(250, 1000) === 0.25);
check("the approach gets hotter as more of the demand is queued", approachHeat(0.7, 0.8) > approachHeat(0.7, 0.2));
