import test from 'node:test';
import assert from 'node:assert/strict';
import {NativeController,nativeCommand} from '../dist/native-control.js';
const method=command=>command.match(/remote\.call\('autorio-control',"(\w+)"/)?.[1];
test('native actions wait for game-confirmed completion and preserve actual movement/mining results',async()=>{
 const calls=[];let polls=0;
 const controller=new NativeController(async command=>{
  const type=method(command);calls.push(type);
  if(type==='start')return JSON.stringify({ok:true,status:'running'});
  return JSON.stringify(++polls<2?{ok:true,status:'running'}:{ok:true,status:'done',mined_count:1,movement:{distance:4.2,game_ticks:40}});
 },async()=>{});
 const result=await controller.run({kind:'mine',target:{x:1,y:2}},()=>false);
 assert.equal(result.ok,true);assert.equal(result.mined_count,1);assert.equal(result.movement.game_ticks,40);
 assert.deepEqual(calls,['start','poll','poll']);
});
test('cancelling walking/mining stops the owned game action even during a polling wait',async()=>{
 const calls=[];let cancelled=false;
 const controller=new NativeController(async command=>{calls.push(method(command));return JSON.stringify({ok:true,status:method(command)==='stop'?'done':'running'});},async()=>{cancelled=true;});
 const result=await controller.run({kind:'move',x:10,y:20},()=>cancelled);
 assert.equal(result.error,'cancelled');assert.deepEqual(calls,['start','stop']);
 assert.equal((await controller.run({kind:'move',x:10,y:20},()=>true)).error,'cancelled');
 assert.deepEqual(calls,['start','stop']);
});
test('RCON failures still attempt to stop controls and retain the original failure',async()=>{
 const calls=[];
 const controller=new NativeController(async command=>{
  const type=method(command);calls.push(type);
  if(type==='start')return '{"status":"running"}';
  throw new Error(type==='poll'?'RCON disconnected':'stop failed');
 },async()=>{});
 await assert.rejects(controller.run({kind:'move',x:2,y:2},()=>false),/RCON disconnected/);
 assert.deepEqual(calls,['start','poll','stop']);
});
test('native commands preserve JSON without allowing payload strings to escape Lua literals',()=>{
 const command=nativeCommand('start',[{name:']=] "quoted" \\ text'}]);
 assert.match(command,/helpers\.json_to_table\(\[==\[/);
 assert.ok(command.includes('native_control_mod_missing'));
});

test('a cancellation arriving with the final movement reply prevents a subsequent interaction',async()=>{
 let cancelled=false;
 const controller=new NativeController(async()=>{cancelled=true;return JSON.stringify({ok:true,status:'done',movement:{distance:1}});},async()=>{});
 assert.equal((await controller.run({kind:'move',x:1,y:1},()=>cancelled)).error,'cancelled');
});
