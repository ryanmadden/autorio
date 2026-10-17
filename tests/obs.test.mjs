import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {ObsRunRecorder,selectWindow,OBS_PROFILE} from '../dist/obs.js';
function fixture(dir,alreadyRecording=false) {
 const state={active:alreadyRecording,profile:'Personal',profiles:['Personal',OBS_PROFILE],scene:'Personal Scene',directory:dir,inputs:[],mutes:{'Mic/Aux':false},calls:[],fps:60,stops:0,closed:false,startPolls:0,stopBusy:false};
 const client={close(){state.closed=true;},async request(type,data={}){
  state.calls.push([type,data]);
  switch(type){
   case 'GetRecordStatus':if(state.startPolls>0 && --state.startPolls===0)state.active=true;return {outputActive:state.active};
   case 'GetStreamStatus':case 'GetReplayBufferStatus':case 'GetVirtualCamStatus':return {outputActive:false};
   case 'GetProfileList':return {currentProfileName:state.profile,profiles:state.profiles};
   case 'GetCurrentProgramScene':return {sceneName:state.scene};
   case 'CreateProfile':assert.ok(!state.profiles.includes(data.profileName));state.profiles.push(data.profileName);return {};
   case 'SetCurrentProfile':assert.ok(state.profiles.includes(data.profileName));state.profile=data.profileName;return {};
   case 'GetRecordDirectory':return {recordDirectory:state.directory};
   case 'SetRecordDirectory':if(state.stopBusy){state.stopBusy=false;throw new Error('OBS SetRecordDirectory: 500');}state.directory=data.recordDirectory;return {};
   case 'SetVideoSettings':state.fps=data.fpsNumerator/data.fpsDenominator;return {};
   case 'GetVideoSettings':return {fpsNumerator:state.fps,fpsDenominator:1,outputWidth:1920,outputHeight:1080};
   case 'GetSceneList':return {scenes:[]};
   case 'GetInputList':return {inputs:state.inputs};
   case 'CreateInput':state.inputs.push({inputName:data.inputName,inputKind:data.inputKind});return {};
   case 'GetSceneItemList':return {sceneItems:state.inputs.map(i=>({sourceName:i.inputName}))};
   case 'GetInputPropertiesListPropertyItems':return {propertyItems:[{itemName:'[Factorio] Factorio',itemValue:11},{itemName:`[Autorio Recording] Codex run ${path.basename(dir)}`,itemValue:22},{itemName:'[Private App] unrelated window',itemValue:99}]};
   case 'GetSceneItemId':return {sceneItemId:data.sourceName.includes('Factorio')?1:2};
   case 'GetSpecialInputs':return {mic1:'Mic/Aux'};
   case 'GetInputMute':return {inputMuted:state.mutes[data.inputName] || false};
   case 'SetInputMute':state.mutes[data.inputName]=data.inputMuted;return {};
   case 'SetCurrentProgramScene':state.scene=data.sceneName;return {};
   case 'StartRecord':state.startPolls=3;return {};
   case 'StopRecord':state.active=false;state.stopBusy=true;state.stops++;const outputPath=path.join(state.directory,'capture.mov');fs.writeFileSync(outputPath,'capture fixture');return {outputPath};
   default:return {};
  }
 }};
 return {state,client};
}
test('OBS records only the two run windows at 5 fps, mutes audio, and restores the prior profile/scene',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autorio-obs-'));const {state,client}=fixture(dir);
 try{
  const recorder=await ObsRunRecorder.start(dir,client);
  assert.equal(state.fps,5);assert.equal(state.profile,OBS_PROFILE);assert.equal(state.active,true);
  const captures=state.calls.filter(([type])=>type==='SetInputSettings');
  assert.deepEqual(captures.map(([,data])=>data.inputSettings.window),[11,22]);
  assert.ok(captures.every(([,data])=>data.inputSettings.type===1));
  assert.equal(state.mutes['Mic/Aux'],true);
  assert.ok(state.calls.findIndex(([type])=>type==='SetVideoSettings')<state.calls.findIndex(([type])=>type==='StartRecord'));
  const output=await recorder.stop();assert.equal(output,path.join(dir,'video','capture.mov'));
  assert.equal(state.stops,1);assert.equal(state.profile,'Personal');assert.equal(state.scene,'Personal Scene');assert.equal(state.mutes['Mic/Aux'],false);assert.equal(state.closed,true);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('OBS refuses to take over an existing recording',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autorio-obs-'));const {state,client}=fixture(dir,true);
 try{await assert.rejects(ObsRunRecorder.start(dir,client),/already has an active output/);assert.equal(state.stops,0);assert.equal(state.active,true);assert.ok(!state.calls.some(([type])=>type.startsWith('Set')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('OBS does not stop or modify a recording whose ownership changed',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'autorio-obs-'));const {state,client}=fixture(dir);
 try{const recorder=await ObsRunRecorder.start(dir,client);state.profile='Another Profile';state.calls=[];await assert.rejects(recorder.stop(),/ownership changed/);assert.equal(state.stops,0);assert.equal(state.active,true);assert.ok(!state.calls.some(([type])=>type.startsWith('Set')));}finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('OBS requires unique window matches and never falls back to unrelated windows',()=>{
 assert.throws(()=>selectWindow([{itemName:'[Other] secret',itemValue:1}],'game','id'),/uniquely/);
 assert.throws(()=>selectWindow([{itemName:'[Factorio] one',itemValue:1},{itemName:'[Factorio] two',itemValue:2}],'game','id'),/uniquely/);
 assert.equal(selectWindow([{itemName:'[Autorio Recording] Codex run target',itemValue:7},{itemName:'[Autorio Recording] Codex run other',itemValue:8}],'log','target'),7);
});

test('OBS identifies the current generic transcript by native window ID',()=>{
 const items=[{itemName:'[Autorio Recording] Agent transcript',itemValue:100},{itemName:'[Autorio Recording] Agent transcript',itemValue:200},{itemName:'[Other App] Agent transcript',itemValue:300}];
 assert.equal(selectWindow(items,'log','run-id',200),200);
 assert.throws(()=>selectWindow(items,'log','run-id',999),/uniquely/);
 assert.throws(()=>selectWindow([{itemName:'[Autorio Recording] Agent transcript',itemValue:200,itemEnabled:false}],'log','run-id',200),/uniquely/);
});
