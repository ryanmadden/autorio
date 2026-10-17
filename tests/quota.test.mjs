import test from 'node:test';
import assert from 'node:assert/strict';
import {quotaError} from '../dist/quota.js';
test('quota detection accepts structured errors and plan-limit messages, but excludes transient throttling and tool output',()=>{
 assert.match(quotaError({type:'turn.failed',error:{code:'usage_limit_exceeded',message:'Account limit exhausted'}}),/Account/);
 assert.ok(quotaError({type:'error',message:"You've hit your usage limit. Try again at 5:00 PM."}));
 assert.ok(quotaError({type:'turn.failed',error:{codex_error_info:'UsageLimitExceeded'}}));
 assert.equal(quotaError({type:'error',message:'429 Too many requests; retrying',code:'rate_limit_exceeded'}),undefined);
 assert.equal(quotaError({type:'item.completed',item:{type:'command_execution',aggregated_output:"You've hit your usage limit"}}),undefined);
 assert.equal(quotaError({type:'item.completed',item:{type:'agent_message',text:"You've hit your usage limit"}}),undefined);
 assert.equal(quotaError({type:'turn.failed',error:{message:'network disconnected'}}),undefined);
});
