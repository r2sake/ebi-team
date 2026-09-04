// loadCodeAssist だけを叩いて tier を読む（生成呼び出しなし＝トークン消費0）
import { readFileSync } from 'node:fs';
const creds = JSON.parse(readFileSync(process.env.HOME + '/.gemini/oauth_creds.json', 'utf8'));
// access_token 期限切れなら refresh
async function token() {
  if (creds.expiry_date > Date.now() + 60000) return creds.access_token;
  const core = '/Users/yoimaro/.npm-global/lib/node_modules/@google/gemini-cli/node_modules/@google/gemini-cli-core/dist/src/code_assist/oauth2.js';
  const m = await import(core);
  const c = await m.getOauthClient(m.AuthType ? 'oauth-personal' : 'oauth-personal', { getProxy: () => undefined, getNoBrowser: () => true, storage: undefined });
  return (await c.getAccessToken()).token;
}
const at = await token();
const project = process.argv[2] || undefined;
const body = { cloudaicompanionProject: project, metadata: { ideType: 'IDE_UNSPECIFIED', platform: 'PLATFORM_UNSPECIFIED', pluginType: 'GEMINI', duetProject: project } };
const res = await fetch('https://cloudcode-pa.googleapis.com/v1internal:loadCodeAssist', {
  method: 'POST', headers: { Authorization: `Bearer ${at}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
console.log('HTTP', res.status);
console.log(JSON.stringify(JSON.parse(await res.text()), null, 2).slice(0, 4000));
