import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
const python = process.platform === 'win32' ? 'python' : 'python3';
const available = spawnSync(python, ['--version'], { timeout: 3000, windowsHide: true }).status === 0;
it.skipIf(!available)('retries Hermes artifact replacement without replaying work or sharing temporary files', () => {
  const result = spawnSync(python, ['-c', String.raw`
import importlib.util, os, tempfile, pathlib, errno, concurrent.futures
spec=importlib.util.spec_from_file_location('hook','adapters/hermes/handler.py')
h=importlib.util.module_from_spec(spec);spec.loader.exec_module(h)
with tempfile.TemporaryDirectory() as root:
    source=pathlib.Path(root)/'source.txt';source.write_text('complete content')
    target=pathlib.Path(root)/'target.txt';target.write_text('previous')
    replace=h.os.replace;calls=[]
    def transient(s,t):
        calls.append(s)
        if len(calls)<3: raise PermissionError(errno.EACCES,'locked')
        replace(s,t)
    h.os.replace=transient
    h._replace_with_retry(str(source),str(target))
    assert len(calls)==3 and target.read_text()=='complete content'
    source.write_text('next')
    def permanent(s,t): raise OSError(errno.EIO,'disk failed')
    h.os.replace=permanent
    try: h._replace_with_retry(str(source),str(target));raise AssertionError('must fail')
    except OSError as e: assert e.errno==errno.EIO
    assert target.read_text()=='complete content' and source.read_text()=='next'
    h.os.replace=replace;h._artifact_root=lambda:str(pathlib.Path(root)/'artifacts')
    with concurrent.futures.ThreadPoolExecutor(max_workers=8) as pool:
        items=list(pool.map(lambda _:h._snapshot_artifact('task',str(source)),range(8)))
    assert len({item['localPath'] for item in items})==1
    published=pathlib.Path(items[0]['localPath'])
    assert published.read_text()=='next' and list(published.parent.iterdir())==[published]
`], { encoding: 'utf8', timeout: 10000, windowsHide: true });
  expect(result.status, result.stderr).toBe(0);
});
