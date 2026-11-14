import test from 'node:test';import assert from 'node:assert/strict';
import {isLocalLoginPage} from '../shared/local-login-page.mjs';
test('manual login page allowlist accepts only exact opaque loopback URLs',()=>{
 const path='/sign-in/'+'a'.repeat(43),valid='http://127.0.0.1:1456'+path;
 assert.equal(isLocalLoginPage(valid),true);assert.equal(isLocalLoginPage('http://127.0.0.1:65535'+path),true);
 for(const value of [undefined,null,{},'',valid+'?code=x',valid+'#x',valid+'/continue',valid+'\n',valid.replace('1456','65536'),valid.replace('1456','0'),valid.replace('1456','01456'),valid.replace('127.0.0.1','localhost'),valid.replace('http:','https:'),valid.replace('127.0.0.1','user@127.0.0.1'),valid.replace('/sign-in/','/x/../sign-in/'),valid.replace('/sign-in/','/%73ign-in/'),'javascript:alert(1)','https://auth.openai.com/api/accounts/authorize?state=secret',valid.slice(0,-1)])assert.equal(isLocalLoginPage(value),false,String(value));
});
