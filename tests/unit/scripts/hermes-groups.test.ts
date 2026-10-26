import { spawnSync } from 'node:child_process';
import { it, expect } from 'vitest';
const python = process.platform === 'win32' ? 'python' : 'python3';
const available = spawnSync(python, ['--version'], { timeout: 3000, windowsHide: true }).status === 0;

it.skipIf(!available)('gives Hermes the same group/topic boundaries and passive observation contract', () => {
  const result = spawnSync(python, ['-c', String.raw`
import importlib.util, os, tempfile, pathlib, json
spec=importlib.util.spec_from_file_location('hook', 'adapters/hermes/handler.py')
h=importlib.util.module_from_spec(spec); spec.loader.exec_module(h)
os.environ.update(LARK_COLLAB_HUB_URL='http://unused',LARK_COLLAB_HUB_TOKEN='test',LARK_COLLAB_TENANT_KEY='tenant',LARK_COLLAB_AGENT_ID='worker',LARK_COLLAB_EVENT_SOURCE='distributed',LARK_MEMORY_ENABLED='0')
with tempfile.TemporaryDirectory() as ledger:
    os.environ['LARK_COLLAB_NODE_LEDGER_ROOT']=ledger
    c={'chat_id':'g','message_id':'quiet','thread_id':'','user_id':'u'}
    h._record_local_topic(c,'message','earlier requirements')
    h._record_local_topic({**c,'message_id':'topic','thread_id':'omt_t'},'message','topic record')
    rows=[json.loads(line) for p in pathlib.Path(ledger).rglob('*.jsonl') for line in p.read_text(encoding='utf-8').splitlines()]
    assert {r['scope'] for r in rows}=={'g','g:omt_t'}
os.environ.pop('LARK_COLLAB_NODE_LEDGER_ROOT',None)
calls=[]; records=[]
def request(path, **kw):
    calls.append((path,kw))
    if 'prompt-context' in path: return {'promptContext':'CONTEXT'}
    return {'dispatches':[{'id':'dispatch','targetAgentId':'worker'}]}
h._request=request; h._record_local_topic=lambda c,k,t:records.append((h._conversation_scope(c),t)); h._register_artifacts=lambda *a:None
c={'platform':'feishu','chat_type':'group','chat_id':'g','message_id':'m','thread_id':'','user_id':'u','message_full':'earlier requirements','mentioned_bot':False}
h._on_observation(c)
assert calls[0][1]['body']['address']['threadId']=='_chat'
assert calls[0][1]['body']['targetAgentIds']==[]
assert len(calls)==1 and records[0][0]=='g'
calls.clear(); d={**c,'message_id':'next','mentioned_bot':True,'session_id':'s'}
h._on_start(d)
assert not d.get('cancel') and d['message_full'].startswith('CONTEXT')
assert calls[0][1]['body']['targetAgentIds']==['worker']
assert calls[-1][1]['body']['status']=='accepted'
assert h._conversation_thread({**c,'thread_id':'m'})=='_chat'
assert h._conversation_scope({**c,'thread_id':'omt_topic'})=='g:omt_topic'
calls.clear(); h._on_start({**c,'chat_type':'dm'}); h._on_observation({**c,'chat_type':'dm'})
assert calls==[]
print('HERMES_GROUP_CONTRACT_OK')
`], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  expect(result.stdout + result.stderr).toContain('HERMES_GROUP_CONTRACT_OK');
  expect(result.status).toBe(0);
});
