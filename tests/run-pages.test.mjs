import test from 'node:test';
import assert from 'node:assert/strict';
import {detailsUrl,recordingUrl} from '../public/run-view.js';

test('run links keep details and recording navigation separate and encode IDs',()=>{
 assert.equal(detailsUrl('Pacific run & high'),'/run.html?run=Pacific%20run%20%26%20high');
 assert.equal(recordingUrl('Pacific run & high'),'/recording.html?run=Pacific%20run%20%26%20high');
});
test('comparison page shows model thinking levels, outcomes, tokens, and missing milestones',async()=>{
 class Node { children=[];textContent='';append(...nodes){this.children.push(...nodes);}replaceChildren(...nodes){this.children=nodes;} }
 const nodes=Object.fromEntries(['error','matching','comparison'].map(id=>[id,new Node()]));
 const fixtures={first:{id:'first',name:'Pacific first run',model_label:'test-model (high)',state:'completed',elapsed_seconds:12,usage:{input_tokens:100,output_tokens:20},milestones:{science:{wall_seconds:10}},hashes:{benchmark:'same',baseline_save:'same',client:'same'}},second:{id:'second',name:'Pacific second run',model_label:'test-model (low)',state:'timed_out',elapsed_seconds:30,milestones:{},hashes:{benchmark:'same',baseline_save:'same',client:'same'}}};
 const oldFetch=globalThis.fetch;
 globalThis.document={getElementById:id=>nodes[id],createElement:()=>new Node()};
 globalThis.location={search:'?runs=first,second'};
 globalThis.fetch=async url=>({ok:true,json:async()=>fixtures[url.split('/').at(-1)]});
 try {
  await import('../public/compare.js');
  assert.equal(nodes.error.textContent,'');
  assert.match(nodes.matching.textContent,/Matching benchmark/);
  const rows=nodes.comparison.children;
  assert.equal(rows[0].children[1].children[0].href,'/run.html?run=first');
  assert.deepEqual(rows[1].children.map(c=>c.textContent),['Agent','test-model (high)','test-model (low)']);
  assert.deepEqual(rows.at(-1).children.map(c=>c.textContent),['science','10.0s','—']);
 } finally {globalThis.fetch=oldFetch;delete globalThis.document;delete globalThis.location;}
});
