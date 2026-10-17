import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionUsage } from "../dist/token-usage.js";

test('recovers latest cumulative usage from the matching session across large output', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'autorio-usage-'));
  const date = new Date().toISOString().slice(0,10).replaceAll('-', '/');
  const dir = path.join(home, 'sessions', date); fs.mkdirSync(dir, {recursive:true});
  const count = n => JSON.stringify({type:'event_msg',payload:{type:'token_count',info:{total_token_usage:{input_tokens:n,cached_input_tokens:4,output_tokens:3,total_tokens:n+3}}}})+'\n';
  fs.writeFileSync(path.join(dir,'rollout-other.jsonl'),count(999));
  const file = path.join(dir,'rollout-test-session.jsonl');
  fs.writeFileSync(file, count(10)+count(20)+JSON.stringify({type:'response_item',text:'x'.repeat(180000)})+'\n{"unfinished":');
  try {
    assert.equal(sessionUsage('test-session',new Date().toISOString(),home).input_tokens,20);
    assert.equal(sessionUsage('missing',new Date().toISOString(),home),undefined);
    assert.equal(sessionUsage('../other',new Date().toISOString(),home),undefined);
    fs.appendFileSync(file,'true}\n'+count(30));
    assert.equal(sessionUsage('test-session',new Date().toISOString(),home).total_tokens,33);
  } finally { fs.rmSync(home,{recursive:true,force:true}); }
});
