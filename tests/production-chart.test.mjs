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
    const tag=nodes.productionChart.children.find(n=>n.attributes.role==='img');
    assert.match(tag.attributes['aria-label'],/^Logistic science research: 0.08m/);
    assert.equal(tag.children[2].attributes.href,'/icons/logistic-science-pack.png');
    const legend=nodes.researchMarkers.children[0];
    assert.equal(legend.children[0].src,'/icons/logistic-science-pack.png');
    assert.match(legend.children[1].textContent,/^Logistic science research:/);
    const production=nodes.productionChart.children.find(n=>n.attributes.points);
    assert.equal(production.attributes.points,'60,250 870,30');
    nodes.chartTime.value='game'; chart.draw();
    marker=nodes.productionChart.children.find(n=>n.attributes['stroke-dasharray']);
    assert.equal(Number(marker.attributes.x1),60+810*2/10);
    nodes.chartMeasure.value='rate'; chart.draw();
    assert.match(nodes.chartNote.textContent,/items \/ game minute/);
    nodes.chartMeasure.value='total';
    chart.samples[0].production['iron-plate']=173100;
    chart.draw();
    const yLabels=nodes.productionChart.children.filter(n=>n.attributes.x==='50').map(n=>n.textContent);
    assert.deepEqual(yLabels,['0','50k','100k','150k','200k']);
    for (const [mode, seconds, labels] of [
      ['wall',7*3600,['0h','2h','4h','6h','8h']],
      ['game',35*60,['0m','10m','20m','30m','40m']],
      ['wall',17,['0s','5s','10s','15s','20s']],
    ]) {
      nodes.chartTime.value=mode;
      chart.samples[0].wall_seconds=seconds;
      chart.samples[0].game_ticks=seconds*60;
      chart.draw();
      const xLabels=nodes.productionChart.children.filter(n=>n.attributes.y==='275').map(n=>n.textContent);
      assert.deepEqual(xLabels,labels);
      const research=nodes.productionChart.children.find(n=>n.attributes['stroke-dasharray']);
      const roundedSeconds=Number(labels.at(-1).slice(0,-1))*(labels[0].endsWith('h')?3600:labels[0].endsWith('m')?60:1);
      assert.equal(Number(research.attributes.x1),60+810*(mode==='game'?2:5)/roundedSeconds);
    }
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

test('finished and paused charts drain telemetry before drawing; active charts keep polling', async () => {
  const originalFetch = globalThis.fetch;
  const originalDocument = globalThis.document;
  const nodes = Object.fromEntries(['chartItem','chartMeasure','chartTime','productionChart','researchMarkers','chartNote','telemetryDownload'].map(id=>[id,new Node()]));
  globalThis.document = {getElementById:id=>nodes[id],createElement:()=>new Node(),createElementNS:()=>new Node()};
  try {
    for (const state of ['completed','failed','stopped','timed_out','interrupted','paused','running']) {
      const chart = new ProductionChart();
      const payload = Buffer.from('{"wall_seconds":1,"production":{"iron-plate":1},"note":"科学"}\n{"wall_seconds":2,"production":{"iron-plate":2}}\n');
      const split = payload.indexOf(Buffer.from('科学')) + 1;
      const chunks = [payload.subarray(0,split),payload.subarray(split),Buffer.alloc(0)];
      let calls = 0, offset = 0, draws = 0;
      globalThis.fetch = async url => {
        assert.equal(new URL(url,'http://localhost').searchParams.get('offset'),String(offset));
        const chunk = chunks[calls++]; offset += chunk.length;
        return {ok:true,json:async()=>({data:chunk.toString('base64'),offset})};
      };
      chart.draw = () => {
        draws++;
        assert.equal(calls,state==='running'?1:3);
        assert.equal(chart.samples.length,state==='running'?0:2);
      };
      await chart.update({id:state,state,benchmark:{milestones:[]}});
      assert.equal(draws,1);
      if (state!=='running') {
        assert.equal(chart.samples[0].note,'科学');
        const download = await (await originalFetch(chart.downloadUrl)).json();
        assert.equal(download.samples.length,2);
      }
      chart.reset(null);
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalDocument) globalThis.document = originalDocument;
    else delete globalThis.document;
  }
});
