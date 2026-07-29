import { chromium } from "playwright";
const browser = await chromium.launch({ executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--use-gl=swiftshader","--enable-unsafe-swiftshader","--no-sandbox"] });
const page = await browser.newPage({ viewport:{width:412,height:915}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
await page.goto("http://127.0.0.1:4173/?seed=alpine&debug=1", { waitUntil:"load" });
await page.waitForSelector("#loading", { state:"hidden", timeout:60000 });
await page.evaluate(() => { const g=window.__game; g.startRun(g.seed); g.obstacles.hitTest=()=>null; });

// Ride for a while, sampling the joints
const res = await page.evaluate(async () => {
  const g = window.__game;
  const legs = g.scene.transformNodes.find(n=>n.name==="riderLegs");
  const hips = g.scene.transformNodes.find(n=>n.name==="riderHips");
  let minLeg=9, maxLeg=-9, minRoll=9, maxRoll=-9, airborneSeen=0, samples=0;
  const legHist=[];
  for (let i=0;i<400;i++){
    await new Promise(r=>setTimeout(r,16));
    const s = legs.scaling.y, r = hips.rotation.z;
    minLeg=Math.min(minLeg,s); maxLeg=Math.max(maxLeg,s);
    minRoll=Math.min(minRoll,r); maxRoll=Math.max(maxRoll,r);
    if (g.controller.airborne) airborneSeen++;
    legHist.push(+s.toFixed(3));
    samples++;
  }
  return { minLeg:+minLeg.toFixed(3), maxLeg:+maxLeg.toFixed(3), minRoll:+minRoll.toFixed(3), maxRoll:+maxRoll.toFixed(3), airPct:Math.round(100*airborneSeen/samples) };
});
console.log("riding:", JSON.stringify(res));

// Now hold a hard steer and read the upper-body lean
await page.evaluate(() => window.__game.startRun(window.__game.seed));
const box = await page.locator("#game").boundingBox();
await page.mouse.move(box.x + box.width*0.97, box.y + box.height*0.7);
await page.mouse.down();
await page.waitForTimeout(900);
const carve = await page.evaluate(() => {
  const g=window.__game;
  const hips = g.scene.transformNodes.find(n=>n.name==="riderHips");
  return { steer:+g.controller.steer.toFixed(2), upperRoll:+hips.rotation.z.toFixed(3), upperYaw:+hips.rotation.y.toFixed(3) };
});
await page.mouse.up();
console.log("hard right carve:", JSON.stringify(carve));
await browser.close();
