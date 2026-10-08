import { queueChange, queueDiameter } from "../src/queue.js";

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
