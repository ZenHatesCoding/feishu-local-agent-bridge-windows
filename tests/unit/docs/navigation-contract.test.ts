import { access, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = process.cwd();
const pairs: Array<readonly [string, string]> = [
  ['docs/AGENT_BRIDGES.md', 'docs/AGENT_BRIDGES.zh-CN.md'],
  ['docs/COLLABORATION_CONCEPTS.md', 'docs/COLLABORATION_CONCEPTS.zh-CN.md'],
  ['docs/DESIGN.md', 'docs/DESIGN.zh-CN.md'],
  ['docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.md', 'docs/DISTRIBUTED_DEPLOYMENT_ROADMAP.zh-CN.md'],
  ['docs/NETWORKING.md', 'docs/NETWORKING.zh-CN.md'],
  ['docs/PRODUCT_VISION.md', 'docs/PRODUCT_VISION.zh-CN.md'],
  ['docs/WINDOWS_OPERATIONS.md', 'docs/WINDOWS_OPERATIONS.zh-CN.md'],
  ['docs/WINDOWS_WORKER_DEPLOYMENT.md', 'docs/WINDOWS_WORKER_DEPLOYMENT.zh-CN.md'],
  ['docs/WINDOWS_WORKER_PITFALLS.md', 'docs/WINDOWS_WORKER_PITFALLS.zh-CN.md'],
  ['scripts/collab-pilot/README.md', 'scripts/collab-pilot/README.zh-CN.md'],
];

describe('documentation navigation', () => {
  it('keeps one unified new-install branch and all supported agents in both READMEs', async () => {
    const docs = await Promise.all(['README.md', 'README.zh.md'].map((file) => readFile(resolve(root, file), 'utf8')));
    for (const content of docs) {
      expect(content).toContain('feature/feishu-multi-agent-hub');
      expect(content).toContain('Claude Code');
      expect(content).toContain('Codex');
      expect(content).toContain('Antigravity');
      expect(content).toContain('DeepSeek Harness');
      expect(content).toContain('Hermes');
      expect(content).toContain('AGENT_BRIDGES');
      expect(content).toContain('COLLABORATION_CONCEPTS');
      expect(content).toContain('DESIGN');
      expect(content).toContain('DISTRIBUTED_DEPLOYMENT_ROADMAP');
      expect(content).toContain('NETWORKING');
      expect(content).toContain('PRODUCT_VISION');
      expect(content).toContain('WINDOWS_OPERATIONS');
    }
  });

  it('routes coding agents from AGENTS.md to every maintained documentation area', async () => {
    const guide = await readFile(resolve(root, 'AGENTS.md'), 'utf8');
    for (const name of [
      'README.md', 'PRODUCT_VISION', 'COLLABORATION_CONCEPTS', 'DESIGN',
      'AGENT_BRIDGES', 'WINDOWS_OPERATIONS', 'NETWORKING',
      'DISTRIBUTED_DEPLOYMENT_ROADMAP', 'scripts/collab-pilot/README',
    ]) {
      expect(guide).toContain(name);
    }
  });

  it('keeps an English and Chinese counterpart with README backlinks', async () => {
    for (const [english, chinese] of pairs) {
      const [en, zh] = await Promise.all([
        readFile(resolve(root, english), 'utf8'),
        readFile(resolve(root, chinese), 'utf8'),
      ]);
      expect(en, english).toContain(chinese.split('/').at(-1));
      expect(zh, chinese).toContain(english.split('/').at(-1));
      expect(en, english).toMatch(/README\.md/);
      expect(zh, chinese).toMatch(/README(?:\.zh)?\.md/);
    }
  });

  it('has no broken relative Markdown links in entry and maintained docs', async () => {
    const files = ['README.md', 'README.zh.md', 'AGENTS.md', ...pairs.flat()];
    for (const file of files) {
      const content = await readFile(resolve(root, file), 'utf8');
      for (const match of content.matchAll(/\[[^\]]+\]\((?!https?:|#)([^)]+)\)/g)) {
        const target = match[1]?.split('#')[0];
        if (!target) continue;
        await expect(access(resolve(dirname(resolve(root, file)), target)), `${file} -> ${target}`).resolves.toBeUndefined();
      }
    }
  });
});
