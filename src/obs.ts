import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {DATA_DIR,execFileAsync} from "./runtime.js";
import {ObsClient,ObsConnection} from "./obs-client.js";
export const OBS_SCENE="Autorio Runs", OBS_PROFILE="Autorio Timelapse";
const GAME="Autorio · Factorio", LOG="Autorio · Codex";
const settingsFile=path.join(DATA_DIR,"obs-settings.json");
export function obsEnabled() {try{return process.env.AUTORIO_OBS!=="0" && (process.env.AUTORIO_OBS==="1" || JSON.parse(fs.readFileSync(settingsFile,"utf8")).enabled===true);}catch{return process.env.AUTORIO_OBS==="1";}}
export async function connectObs() {
  let config:any={};
  try{config=JSON.parse(fs.readFileSync(path.join(os.homedir(),"Library/Application Support/obs-studio/plugin_config/obs-websocket/config.json"),"utf8"));}catch{ /* Environment settings also supported. */ }
  return ObsClient.connect(process.env.OBS_WEBSOCKET_URL || `ws://127.0.0.1:${config.server_port || 4455}`,process.env.OBS_WEBSOCKET_PASSWORD || config.server_password);
}
export async function obsStatus() {
  let client:ObsConnection|undefined;
  try {
    client=await connectObs();
    const version=await client.request("GetVersion");
    const status=await client.request("GetRecordStatus");
    return {enabled:obsEnabled(),connected:true,version:version.obsVersion,recording:status.outputActive,capture_fps:5,playback_fps:30,speed:6};
  } catch(error){return {enabled:obsEnabled(),connected:false,message:error instanceof Error?error.message:String(error),capture_fps:5,playback_fps:30,speed:6};}
  finally{client?.close();}
}
const pause=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
export function selectWindow(items:any[],which:"game"|"log",runId:string,windowId?:number) {
  const candidates=items.filter(item=>item.itemEnabled!==false && (which==="log" ? (windowId!==undefined ? /(?:^|\] )Agent transcript$/.test(item.itemName) && Number(item.itemValue)===windowId : item.itemName.includes(`Codex run ${runId}`)) : /^\[Factorio\]/i.test(item.itemName)));
  if(candidates.length!==1)throw new Error(`OBS could not uniquely find the ${which==="game"?"Factorio":"current Codex log"} window. Keep both windows open and allow OBS Screen Recording permission.`);
  return candidates[0].itemValue;
}
export class ObsRunRecorder {
  private originalProfile?:string;
  private originalScene?:string;
  private originalDirectory?:string;
  private mutes=new Map<string,boolean>();
  private owns=false;
  private restoreAllowed=true;
  private constructor(readonly dir:string,private client:ObsConnection,private windowRunId:string,private windowId?:number){}
  static async start(dir:string,client?:ObsConnection,runId=path.basename(dir),windowId?:number) {
    const recorder=new ObsRunRecorder(dir,client || await connectObs(),runId,windowId);
    try{await recorder.prepare();return recorder;}
    catch(error){await recorder.restore().catch(()=>{});recorder.client.close();throw error;}
  }
  private async prepare() {
    for(const request of ["GetRecordStatus","GetStreamStatus","GetReplayBufferStatus","GetVirtualCamStatus"]){
      let status:any;
      try{status=await this.client.request(request);}catch(error){
        if(["GetReplayBufferStatus","GetVirtualCamStatus"].includes(request) && /not (available|configured)/i.test(String(error)))continue;
        throw error;
      }
      if(status.outputActive)throw new Error("OBS already has an active output. Stop it before starting an automatically recorded run.");
    }
    const profiles=await this.client.request("GetProfileList");this.originalProfile=profiles.currentProfileName;
    this.originalScene=(await this.client.request("GetCurrentProgramScene")).sceneName;
    if(profiles.profiles.some((p:any)=>(typeof p==="string"?p:p.profileName)===OBS_PROFILE))await this.client.request("SetCurrentProfile",{profileName:OBS_PROFILE});
    else await this.client.request("CreateProfile",{profileName:OBS_PROFILE});
    await this.client.request("SetCurrentProfile",{profileName:OBS_PROFILE});
    let profileReady=false;
    for(let attempt=0;attempt<30;attempt++){if((await this.client.request("GetProfileList")).currentProfileName===OBS_PROFILE){profileReady=true;break;}await pause(100);}
    if(!profileReady)throw new Error("OBS profile did not finish switching");
    this.originalDirectory=(await this.client.request("GetRecordDirectory")).recordDirectory;
    for(const [category,name,value] of [["Output","Mode","Simple"],["SimpleOutput","RecFormat2","hybrid_mov"],["SimpleOutput","RecEncoder","apple_h264"],["SimpleOutput","RecQuality","HQ"]]) await this.client.request("SetProfileParameter",{parameterCategory:category,parameterName:name,parameterValue:value});
    await this.client.request("SetVideoSettings",{fpsNumerator:5,fpsDenominator:1,baseWidth:1920,baseHeight:1080,outputWidth:1920,outputHeight:1080});
    let videoReady=false;
    for(let attempt=0;attempt<50;attempt++){
      const video=await this.client.request("GetVideoSettings");
      if(video.fpsNumerator/video.fpsDenominator===5 && video.outputWidth===1920 && video.outputHeight===1080){videoReady=true;break;}
      await pause(100);
    }
    if(!videoReady)throw new Error("OBS did not apply 1920×1080 at 5 fps");
    const sceneList=await this.client.request("GetSceneList");
    if(!sceneList.scenes.some((s:any)=>s.sceneName===OBS_SCENE))await this.client.request("CreateScene",{sceneName:OBS_SCENE});
    let inputs=(await this.client.request("GetInputList")).inputs;
    for(const name of [GAME,LOG]) {
      const existing=inputs.find((i:any)=>i.inputName===name);
      if(existing && existing.inputKind!=="screen_capture")throw new Error(`Reserved OBS source name is already in use: ${name}`);
      if(!existing)await this.client.request("CreateInput",{sceneName:OBS_SCENE,inputName:name,inputKind:"screen_capture",inputSettings:{type:1,window:0,show_cursor:false,show_hidden_windows:true},sceneItemEnabled:true});
      const sceneItems=(await this.client.request("GetSceneItemList",{sceneName:OBS_SCENE})).sceneItems;
      if(!sceneItems.some((i:any)=>i.sourceName===name))await this.client.request("CreateSceneItem",{sceneName:OBS_SCENE,sourceName:name,sceneItemEnabled:true});
      let window:any;
      for(let attempt=0;attempt<10;attempt++) {
        const items=(await this.client.request("GetInputPropertiesListPropertyItems",{inputName:name,propertyName:"window"})).propertyItems;
        try{window=selectWindow(items,name===GAME?"game":"log",this.windowRunId,this.windowId);break;}catch(error){if(attempt===9)throw error;await pause(300);}
      }
      await this.client.request("SetInputSettings",{inputName:name,inputSettings:{type:1,window,show_cursor:false,show_hidden_windows:true},overlay:false});
      const itemId=(await this.client.request("GetSceneItemId",{sceneName:OBS_SCENE,sourceName:name})).sceneItemId;
      await this.client.request("SetSceneItemEnabled",{sceneName:OBS_SCENE,sceneItemId:itemId,sceneItemEnabled:true});
      await this.client.request("SetSceneItemTransform",{sceneName:OBS_SCENE,sceneItemId:itemId,sceneItemTransform:{positionX:name===GAME?0:1280,positionY:0,rotation:0,alignment:5,boundsType:"OBS_BOUNDS_SCALE_INNER",boundsAlignment:0,boundsWidth:name===GAME?1280:640,boundsHeight:1080,cropLeft:0,cropRight:0,cropTop:0,cropBottom:0}});
    }
    // The dedicated scene must contain exactly the two approved windows.
    const sceneItems=(await this.client.request("GetSceneItemList",{sceneName:OBS_SCENE})).sceneItems;
    if(sceneItems.some((i:any)=>![GAME,LOG].includes(i.sourceName)))throw new Error("Autorio Runs scene has extra sources; remove them before automatic recording");
    const audio=await this.client.request("GetSpecialInputs");
    for(const name of new Set<string>([...Object.values(audio).filter((v):v is string=>typeof v==="string" && !!v),GAME,LOG])) {
      const mute=await this.client.request("GetInputMute",{inputName:name});this.mutes.set(name,mute.inputMuted);
      await this.client.request("SetInputMute",{inputName:name,inputMuted:true});
    }
    await this.client.request("SetCurrentProgramScene",{sceneName:OBS_SCENE});
    const captureDir=path.join(this.dir,"video");fs.mkdirSync(captureDir,{recursive:true});
    await this.client.request("SetRecordDirectory",{recordDirectory:captureDir});
    for(let attempt=0;attempt<30;attempt++) {
      if(path.resolve((await this.client.request("GetRecordDirectory")).recordDirectory)===captureDir)break;
      if(attempt===29)throw new Error("OBS did not apply the run recording directory");
      await pause(100);
    }
    this.owns=true;
    await this.client.request("StartRecord");
    let recordingReady=false;
    for(let attempt=0;attempt<100;attempt++) {
      if((await this.client.request("GetRecordStatus")).outputActive){recordingReady=true;break;}
      await pause(100);
    }
    if(!recordingReady)throw new Error("OBS recording did not start");
    fs.writeFileSync(path.join(this.dir,"video","capture.json"),JSON.stringify({capture_fps:5,playback_fps:30,speed:6,scene:OBS_SCENE,started_at:new Date().toISOString()},null,2));
  }
  async stop():Promise<string> {
    try {
      const directory=(await this.client.request("GetRecordDirectory")).recordDirectory;
      const profile=(await this.client.request("GetProfileList")).currentProfileName;
      if(path.resolve(directory)!==path.join(this.dir,"video") || profile!==OBS_PROFILE){this.owns=false;this.restoreAllowed=false;throw new Error("OBS output ownership changed; refusing to stop an unrelated recording");}
      const result=await this.client.request("StopRecord");this.owns=false;
      const output=path.resolve(result.outputPath);
      if(path.dirname(output)!==path.join(this.dir,"video"))throw new Error("OBS saved the recording outside this run's video directory");
      return output;
    } finally {try{if(this.restoreAllowed)await this.restore();}finally{this.client.close();}}
  }
  private async restoreSetting(type:string,data:Record<string,unknown>) {
    for(let attempt=0;;attempt++) {
      try{return await this.client.request(type,data);}
      catch(error){if(attempt>=99 || !/: 500$/.test(String(error)))throw error;await pause(100);}
    }
  }
  private async restore() {
    if(this.owns) {
      const directory=(await this.client.request("GetRecordDirectory")).recordDirectory;
      if(path.resolve(directory)!==path.join(this.dir,"video") || (await this.client.request("GetProfileList")).currentProfileName!==OBS_PROFILE)throw new Error("OBS output ownership changed during cleanup");
      if((await this.client.request("GetRecordStatus")).outputActive)await this.client.request("StopRecord");
      this.owns=false;
    }
    for(const [name,inputMuted] of this.mutes)await this.client.request("SetInputMute",{inputName:name,inputMuted});
    if(this.originalDirectory)await this.restoreSetting("SetRecordDirectory",{recordDirectory:this.originalDirectory});
    if(this.originalProfile)await this.restoreSetting("SetCurrentProfile",{profileName:this.originalProfile});
    if(this.originalScene)await this.client.request("SetCurrentProgramScene",{sceneName:this.originalScene});
  }
}
export async function ensureObsRunning() {await execFileAsync("/usr/bin/open",["-g","-a","/Applications/OBS.app"],{timeout:10000});}
