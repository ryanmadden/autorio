import fs from "node:fs";
import path from "node:path";
import {createHash} from "node:crypto";
import {DATA_DIR,ROOT,execFileAsync} from "./runtime.js";
export const TIMELAPSE_TOOL=path.join(DATA_DIR,"tools","autorio-timelapse");
let building:Promise<void>|undefined;
export async function buildTimelapseTool() {
  if(building)return building;
  building=(async()=>{
    const source=path.join(ROOT,"native/timelapse.swift"),stamp=TIMELAPSE_TOOL+".sha256";
    const hash=createHash("sha256").update(fs.readFileSync(source)).digest("hex");
    if(fs.existsSync(TIMELAPSE_TOOL) && fs.existsSync(stamp) && fs.readFileSync(stamp,"utf8")===hash)return;
    fs.mkdirSync(path.dirname(TIMELAPSE_TOOL),{recursive:true});
    const cache=path.join(DATA_DIR,"swift-module-cache");fs.mkdirSync(cache,{recursive:true});
    await execFileAsync("/usr/bin/xcrun",["swiftc","-sdk",process.env.AUTORIO_MACOS_SDK || "/Library/Developer/CommandLineTools/SDKs/MacOSX.sdk","-parse-as-library","-O","-module-cache-path",cache,source,"-o",TIMELAPSE_TOOL],{timeout:120000});
    fs.writeFileSync(stamp,hash);
  })();
  try{await building;}finally{building=undefined;}
}
export async function renderTimelapse(source:string,dir:string) {
  await buildTimelapseTool();
  const target=path.join(dir,"timelapse.mp4"),temporary=path.join(dir,"timelapse.partial.mp4");
  fs.rmSync(temporary,{force:true});
  const {stdout}=await execFileAsync(TIMELAPSE_TOOL,[source,temporary],{timeout:12*60*60*1000,maxBuffer:1024*1024});
  const metadata=JSON.parse(stdout);
  if(metadata.fps!==30 || metadata.frames<1)throw new Error("Timelapse output verification failed");
  fs.renameSync(temporary,target);fs.writeFileSync(path.join(dir,"timelapse.json"),JSON.stringify(metadata,null,2));
  return {file:target,...metadata};
}
