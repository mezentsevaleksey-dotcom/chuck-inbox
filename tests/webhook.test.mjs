import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler from '../api/webhook.js';

function response() {
  return { statusCode: null, body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; } };
}

async function exercise(message, {emailFails = false} = {}) {
  const previous = global.fetch;
  const env = {...process.env};
  process.env.TELEGRAM_BOT_TOKEN = 'test-token';
  process.env.RESEND_API_KEY = 'test-key';
  process.env.CHUCK_INBOX_EMAIL = 'owner@example.org';
  process.env.ALLOWED_TELEGRAM_USER_ID = '42';
  const calls = [];
  global.fetch = async (url, init = {}) => {
    calls.push({url, body: init.body ? JSON.parse(init.body) : null, headers: init.headers});
    if (url === 'https://api.resend.com/emails') {
      return {ok: !emailFails, status: emailFails ? 503 : 200, json: async () => ({id: 'email-test'})};
    }
    if (url.endsWith('/getFile')) return {ok: true, json: async () => ({ok:true,result:{file_path:'photos/test.jpg'}})};
    if (url.includes('/file/')) return {ok:true, arrayBuffer:async()=>new Uint8Array([1,2,3]).buffer,
      headers:new Headers({'content-type':'image/jpeg'})};
    if (url.endsWith('/sendMessage')) return {ok:true,json:async()=>({ok:true,result:{}})};
    throw new Error('Unexpected network destination');
  };
  try {
    const res = response();
    await handler({method:'POST',body:{update_id:123,message}},res);
    return {res,calls};
  } finally {
    global.fetch = previous;
    for (const key of Object.keys(process.env)) if (!(key in env)) delete process.env[key];
    Object.assign(process.env,env);
  }
}
const base = {message_id:7,date:1795348800,from:{id:42,first_name:'Test'},chat:{id:42}};

test('link forwarding and Telegram acknowledgement remain unchanged',async()=>{
  const {res,calls}=await exercise({...base,text:'https://youtu.be/jNQXAC9IVRw'});
  assert.equal(res.statusCode,200); assert.equal(res.body.emailed,true);
  assert.equal(calls.length,2);
  assert.match(calls[0].body.subject,/^\[Chuck Inbox\] /);
  assert.equal(calls[0].headers['Idempotency-Key'],'chuck-inbox-123');
  assert.match(calls[0].body.text,/https:\/\/youtu.be\/jNQXAC9IVRw/);
  assert.equal(calls[1].body.text,'Отправил в Gmail ✅ Ссылка');
});

test('photos still reach Gmail with correct MIME and attachment bytes',async()=>{
  const {res,calls}=await exercise({...base,caption:'photo',photo:[{file_id:'file',file_unique_id:'u'}]});
  assert.equal(res.body.emailed,true);
  const email=calls.find(x=>x.url==='https://api.resend.com/emails');
  assert.equal(email.body.attachments[0].content,'AQID');
  assert.equal(email.body.attachments[0].content_type,'image/jpeg');
});

test('unauthorized Telegram user is ignored before any outbound call',async()=>{
  const {res,calls}=await exercise({...base,from:{id:99},text:'no'});
  assert.equal(res.body.ignored,true); assert.equal(calls.length,0);
});

test('email failure retains the existing Telegram warning',async()=>{
  const log = console.error; console.error = () => {};
  try {
    const {res,calls}=await exercise({...base,text:'hello'},{emailFails:true});
    assert.equal(res.body.emailed,false);
    assert.equal(calls.at(-1).body.text,'Получил, но не смог отправить в Gmail ⚠️');
  } finally { console.error = log; }
});
