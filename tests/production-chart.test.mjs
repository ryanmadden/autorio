import test from 'node:test';
import assert from 'node:assert/strict';
import {ProductionChart} from '../public/production-chart.js';
class Node {
  children=[]; attributes={}; textContent=''; value='';
  setAttribute(k,v) { this.attributes[k]=String(v); }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children=children; }
  removeAttribute(k) { delete this.attributes[k]; }
}
test('production chart aligns research markers with wall and game time and subtracts baseline', () => {
  const nodes = Object.fromEntries(['chartItem','chartMeasure','chartTime','productionChart','researchMarkers','chartNote','telemetryDownload'].map(id=>[id,new Node()]));
  globalThis.document = {getElementById:id=>nodes[id],createElement:()=>new Node(),createElementNS:()=>new Node()};
  try {
    const chart=new ProductionChart();
    nodes.chartItem.value='iron-plate'; nodes.chartMeasure.value='total'; nodes.chartTime.value='wall';
    chart.run={baseline:{production:{'iron-plate':100}},benchmark:{sample_seconds:2,milestones:[{id:'science',kind:'research',name:'logistic-science-pack',label:'Logistic science research'}]},milestones:{science:{wall_seconds:5,game_ticks:120}}};
    chart.samples=[{wall_seconds:20,game_ticks:600,production:{'iron-plate':110},production_per_game_minute:{'iron-plate':60}}];
    chart.draw();
    let marker=nodes.productionChart.children.find(n=>n.attributes['stroke-dasharray']);
    assert.equal(Number(marker.attributes.x1),60+810*5/20);
    assert.match(nodes.researchMarkers.children[0].textContent,/Logistic science research/);
    const production=nodes.productionChart.children.find(n=>n.attributes.points);
    assert.equal(production.attributes.points,'60,250 870,30');
    nodes.chartTime.value='game'; chart.draw();
    marker=nodes.productionChart.children.find(n=>n.attributes['stroke-dasharray']);
    assert.equal(Number(marker.attributes.x1),60+810*2/10);
    nodes.chartMeasure.value='rate'; chart.draw();
    assert.match(nodes.chartNote.textContent,/items \/ game minute/);
  } finally { delete globalThis.document; }
});

test('all-item cumulative production sums baseline-adjusted item outputs and supports separate series',async()=>{
 const {productionSeries,ALL_ITEMS,EACH_ITEM}=await import('../public/production-chart.js');
 const baseline={'iron-plate':100,'copper-plate':200};
 const samples=[{wall_seconds:20,game_ticks:600,production:{'iron-plate':110,'copper-plate':205,'iron-gear-wheel':2},fluids_produced:{water:1000},production_per_game_minute:{'iron-plate':60,'copper-plate':30,'iron-gear-wheel':12}},
 {wall_seconds:30,game_ticks:900,production:{'iron-plate':115,'copper-plate':206,'iron-gear-wheel':4},production_per_game_minute:{'iron-plate':30,'copper-plate':6,'iron-gear-wheel':12}}];
 const combined=productionSeries(samples,baseline,ALL_ITEMS,false,false);
 assert.equal(combined.length,1);
 assert.deepEqual(combined[0].points,[{x:0,y:0},{x:20,y:17},{x:30,y:25}]);
 const separate=productionSeries(samples,baseline,EACH_ITEM,false,true);
 assert.equal(separate.length,3);
 assert.deepEqual(separate.find(s=>s.name==='iron-plate').points,[{x:0,y:0},{x:10,y:10},{x:15,y:15}]);
 assert.equal(separate.reduce((sum,s)=>sum+s.points[2].y,0),25);
 assert.deepEqual(productionSeries(samples,baseline,ALL_ITEMS,true,true)[0].points,[{x:0,y:0},{x:10,y:102},{x:15,y:48}]);
});
