import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { AUDIENCE, ISSUER, REPOSITORY, SENDER, RESULT, SOURCE, RECIPIENT_ALIAS,
  verifyToken, createBridge, canonical } from '../lib/videoBridge.mjs';
import handler from '../api/video-inbox.js';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({format:'jwk'}), kid:'test-key', alg:'RS256', use:'sig' };
const now = 1795382400;
const claims = { iss:ISSUER, aud:AUDIENCE, iat:now-10, nbf:now-10, exp:now+290,
  repository:REPOSITORY, repository_id:'1374085463', repository_owner_id:'330305019',
  repository_visibility:'public', ref:'refs/heads/main', ref_type:'branch',
  sub:'repo:mezentsevaleksey-dotcom@330305019/chuck-inbox@1374085463:ref:refs/heads/main',
  workflow_ref:`${REPOSITORY}/.github/workflows/video-analysis.yml@refs/heads/main`,
  workflow_sha:'a'.repeat(40), sha:'a'.repeat(40), event_name:'workflow_dispatch',
  run_id:'12345', runner_environment:'github-hosted' };
function jwt(overrides={}, header={}) {
  const parts=[{alg:'RS256',kid:'test-key',typ:'JWT',...header},{...claims,...overrides}]
    .map(x=>Buffer.from(JSON.stringify(x)).toString('base64url'));
  return [...parts,sign('RSA-SHA256',Buffer.from(parts.join('.')),privateKey).toString('base64url')].join('.');
}
test('valid signed main-workflow identity is accepted',()=>{
  assert.equal(verifyToken(jwt(),[jwk],now).run_id,claims.run_id);
});
test('forged signature and unsigned/algorithm-confused tokens fail',()=>{
  const good=jwt(); const parts=good.split('.');
  parts[1]=Buffer.from(JSON.stringify({...claims,run_id:'999'})).toString('base64url');
  for(const value of [parts.join('.'),jwt({}, {alg:'none'}),jwt({}, {alg:'HS256'}),good+'.extra'])
    assert.throws(()=>verifyToken(value,[jwk],now),/unauthorized/);
});
test('forks, PRs, other workflows, repo transfers, wrong audience and stale identities fail',()=>{
  for(const change of [{repository_id:'2'},{repository_owner_id:'3'}, {repository:'attacker/chuck-inbox'},
    {ref:'refs/heads/feature/video-analysis'}, {event_name:'pull_request'}, {repository_visibility:'private'},
    {workflow_ref:`${REPOSITORY}/.github/workflows/other.yml@refs/heads/main`},
    {aud:'https://evil.example'}, {iss:'https://evil.example'}, {exp:now-1}, {iat:now-700},
    {nbf:now+100}, {exp:now+10000}, {workflow_sha:'b'.repeat(40)}, {sub:'other'}, {runner_environment:'self-hosted'}])
    assert.throws(()=>verifyToken(jwt(change),[jwk],now),/unauthorized/);
});
test('immutable subject includes the exact owner and repository IDs',()=>{
  for(const sub of [`repo:${REPOSITORY}:ref:refs/heads/main`,
    'repo:mezentsevaleksey-dotcom@1/chuck-inbox@1374085463:ref:refs/heads/main',
    'repo:mezentsevaleksey-dotcom@330305019/chuck-inbox@1:ref:refs/heads/main'])
    assert.throws(()=>verifyToken(jwt({sub}),[jwk],now),/unauthorized/);
});
test('untrusted bearer absence is rejected before any network call or secret access',async()=>{
  const res={statusCode:null,body:null,setHeader(){},status(n){this.statusCode=n;return this},json(x){this.body=x;return this}};
  await handler({method:'POST',headers:{},body:{action:'check'}},res);
  assert.equal(res.statusCode,401); assert.deepEqual(res.body,{error:'unauthorized'});
});

const id='00000000-0000-0000-0000-000000000001';
const resultId='00000000-0000-0000-0000-000000000002';
const url='https://www.youtube.com/watch?v=jNQXAC9IVRw';
const recipient='private-owner@example.org';
const original={id,from:SENDER,to:[recipient],subject:SOURCE+'package',
  created_at:new Date(now*1000-3600000).toISOString(),last_event:'delivered',
  text:'Chuck Inbox - context package item\nSender/source: private person\n\nText/caption:\n'+url};
function setup({rows=[original],source=original,statusEmail,failStatus}={}) {
  const sent=[];
  const fetcher=async(target,init)=>{
    if(failStatus) return new Response('{}',{status:failStatus});
    let result;
    if(target==='https://api.resend.com/emails' && init.method==='POST') {
      sent.push({body:JSON.parse(init.body),headers:init.headers});result={id:resultId};
    } else if(target.includes('/emails?')) result={data:rows,has_more:false};
    else if(target.endsWith('/'+id)) result=source;
    else if(target.endsWith('/'+resultId)) result=statusEmail;
    else throw new Error('unexpected endpoint');
    return new Response(JSON.stringify(result),{status:200});
  };
  return {run:createBridge({key:'never-return-this-secret',recipient,fetcher,pause:async()=>{},
    now:()=>new Date(now*1000)}),sent};
}
test('list redacts recipient and unrelated message subjects',async()=>{
  const {run}=setup({rows:[original,{...original,id:resultId,from:'Private colleague',to:['other@example.org'],subject:'Private project'}]});
  const output=await run({action:'list'},claims);
  assert.deepEqual(output.data[0].to,[RECIPIENT_ALIAS]);
  assert.equal(output.data[1].subject,'');
  assert.ok(!JSON.stringify(output).includes('private-owner'));
  assert.ok(!JSON.stringify(output).includes('Private project'));
});
test('source reads expose only captions, reject other recipients and arbitrary API paths',async()=>{
  const {run}=setup(); const result=await run({action:'read',id},claims);
  assert.ok(result.text.endsWith(url)); assert.ok(!result.text.includes('private person'));
  await assert.rejects(run({action:'read',id:'../../api-keys'},claims));
  await assert.rejects(setup({source:{...original,to:['other@example.org']}}).run({action:'read',id},claims),/source_not_owned/);
});
test('delivery cannot choose recipients, sender or subject, and deduplicates equivalent sources',async()=>{
  const {run,sent}=setup();
  await run({action:'deliver',job:{url,source_id:id},report:'Verified content',to:['attacker@example.org'],subject:'fake'},claims);
  assert.deepEqual(sent[0].body.to,[recipient]); assert.equal(sent[0].body.from,SENDER);
  assert.ok(sent[0].body.subject.startsWith(RESULT));
  assert.match(sent[0].headers['Idempotency-Key'],/^chuck-video-v2-[0-9a-f]{64}$/);
  assert.equal(canonical('https://youtu.be/jNQXAC9IVRw?si=x'),url);
});
test('unrelated, quoted-only, expired, and oversized result deliveries fail before sending',async()=>{
  for(const source of [{...original,text:original.text.replace(url,'https://www.youtube.com/watch?v=aaaaaaaaaaa')},
    {...original,text:'Chuck Inbox - context package item\nReply to: '+url+'\n\nText/caption:\nthanks'},
    {...original,created_at:new Date(now*1000-21*3600000).toISOString()}]) {
    const {run,sent}=setup({source});
    await assert.rejects(run({action:'deliver',job:{url,source_id:id},report:'report'},claims));
    assert.equal(sent.length,0);
  }
  const {run,sent}=setup();
  await assert.rejects(run({action:'deliver',job:{url,source_id:id},report:'x'.repeat(100001)},claims));
  await assert.rejects(run({action:'deliver',job:{url,source_id:id},report:'report',frames:'not-jpeg'},claims));
  assert.equal(sent.length,0);
});
test('repeated fixed-fixture tests have separate labelled results without changing production deduplication',async()=>{
  const fixture='https://www.instagram.com/p/DWuGIV2iTcr/';
  const source={...original,subject:SOURCE+'TEST 12345',text:original.text.replace(url,fixture)};
  const {run,sent}=setup({source});
  await run({action:'deliver',job:{url:fixture,source_id:id},report:'Frame observations'},claims);
  assert.match(sent[0].body.subject,/^\[Chuck Inbox Analysis\] v2 TEST 12345 /);
  assert.equal(sent[0].headers['Idempotency-Key'],'chuck-video-fixture-12345');
  assert.match(sent[0].body.text,/не получен из Telegram/);
});
test('recent-source review extends age only for manual Instagram runs and never beyond 72 hours',async()=>{
  const ig='https://www.instagram.com/p/CLIP_123/';
  const source={...original,text:original.text.replace(url,ig),created_at:new Date(now*1000-30*3600000).toISOString()};
  const input={action:'deliver',job:{url:ig,source_id:id,manual_recent:true},report:'Review'};
  await setup({source}).run(input,claims);
  await assert.rejects(setup({source}).run(input,{...claims,event_name:'schedule'}),/manual_recent_only/);
  await assert.rejects(setup({source}).run({...input,job:{url:ig,source_id:id}},claims),/source_expired/);
  await assert.rejects(setup({source:{...source,created_at:new Date(now*1000-73*3600000).toISOString()}}).run(input,claims),/source_expired/);
  await assert.rejects(setup().run({...input,job:{url,source_id:id,manual_recent:true}},claims),/manual_recent_only/);
});
test('server daily cap preserves allowance for original forwarding',async()=>{
  const {run,sent}=setup({rows:Array.from({length:90},()=>original)});
  await assert.rejects(run({action:'deliver',job:{url,source_id:id},report:'report'},claims),/daily_limit/);
  assert.equal(sent.length,0);
});
test('delivery test is clearly labelled and limited to manual runs and configured recipient',async()=>{
  const {run,sent}=setup();
  await assert.rejects(run({action:'delivery-test'},{...claims,event_name:'schedule'}),/manual_test_only/);
  await run({action:'delivery-test'},claims);
  assert.deepEqual(sent[0].body.to,[recipient]); assert.match(sent[0].body.subject,/^\[Chuck Inbox Test\]/);
  assert.match(sent[0].body.text,/не разбор видео/);
});
test('integration fixture is fixed, labelled as a test, and cannot substitute arbitrary URLs',async()=>{
  const {run,sent}=setup();
  await assert.rejects(run({action:'seed-test'},{...claims,event_name:'schedule'}),/manual_test_only/);
  const job=await run({action:'seed-test',url:'https://attacker.example'},claims);
  assert.equal(job.url,'https://www.instagram.com/p/DWuGIV2iTcr/');
  assert.match(sent[0].body.subject,/^\[Chuck Inbox\] TEST /);
  assert.match(sent[0].body.text,/not a Telegram message/);
  assert.ok(!sent[0].body.text.includes('attacker.example'));
});
test('delivery verification returns only event status of owned result/test emails',async()=>{
  const {run}=setup({statusEmail:{...original,id:resultId,subject:'[Chuck Inbox Test] '+claims.run_id}});
  assert.deepEqual(await run({action:'delivery-status',id:resultId},claims),{status:'delivered'});
  await assert.rejects(setup({statusEmail:{...original,id:resultId,subject:'Unrelated'}}).run({action:'delivery-status',id:resultId},claims),/source_not_owned/);
});
test('sending-only Resend keys produce a fixed error without credential disclosure',async()=>{
  await assert.rejects(setup({failStatus:403}).run({action:'check'},claims),e=>
    e.code==='resend_read_access_required' && !e.message.includes('never-return'));
});
