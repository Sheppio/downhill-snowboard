import { chromium } from "playwright";
const OUT = process.argv[2];
const browser = await chromium.launch({ executablePath:"/opt/pw-browsers/chromium-1194/chrome-linux/chrome", args:["--use-gl=swiftshader","--enable-unsafe-swiftshader","--no-sandbox"] });
const page = await browser.newPage({ viewport:{width:412,height:915}, deviceScaleFactor:2, isMobile:true, hasTouch:true });
await page.goto("http://127.0.0.1:4173/?seed=alpine&debug=1", { waitUntil:"load" });
await page.waitForSelector("#loading", { state:"hidden", timeout:60000 });
await page.evaluate(() => { const g=window.__game; g.startRun(g.seed); g.obstacles.hitTest=()=>null; g.spray.stop(); g.spray.update=()=>{}; });
const box = await page.locator("#game").boundingBox();

// Straight
await page.waitForTimeout(1500);
await page.screenshot({ path:`${OUT}/rider-straight.png`, clip:{x:120,y:520,width:180,height:230} });

// Hard carve
await page.mouse.move(box.x + box.width*0.97, box.y + box.height*0.7);
await page.mouse.down();
await page.waitForTimeout(1100);
await page.screenshot({ path:`${OUT}/rider-carve.png`, clip:{x:120,y:520,width:180,height:230} });
await page.mouse.up();
console.log("done");
await browser.close();
