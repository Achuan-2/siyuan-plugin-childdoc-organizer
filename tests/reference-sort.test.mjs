import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

// 执行实际插件与 API 封装，模拟宿主边界；SQL 故意返回与正文相反的顺序。
const sources = new Map(['api', 'index'].map(name => [name, ts.transpileModule(
    readFileSync(new URL(`../src/${name}.ts`, import.meta.url), 'utf8'),
    { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } },
).outputText]));
const i18n = JSON.parse(readFileSync(new URL('../i18n/zh_CN.json', import.meta.url), 'utf8'));
const plain = value => value === undefined ? undefined : JSON.parse(JSON.stringify(value));

function fixture({ references = ['beta', 'alpha', 'beta', 'existing'], fail } = {}) {
    const blocks = [
        { id: 'ancestor', path: '/ancestor.sy' },
        { id: 'parent', path: '/ancestor/parent.sy' },
        { id: 'alpha', path: '/alpha.sy' },
        { id: 'beta', path: '/beta.sy' },
        { id: 'existing', path: '/ancestor/parent/existing.sy' },
        { id: 'keep-b', path: '/ancestor/parent/keep-b.sy' },
        { id: 'keep-a', path: '/ancestor/parent/keep-a.sy' },
        { id: 'nested-a', path: '/ancestor/parent/existing/nested-a.sy' },
        { id: 'nested-b', path: '/ancestor/parent/existing/nested-b.sy' },
        { id: 'paragraph', path: '/alpha.sy', type: 'p' },
    ].map(block => ({ box: 'notebook', type: 'd', ...block }));
    const calls = [];
    const messages = [];
    const success = data => ({ code: 0, data });
    const fetchSyncPost = async (url, payload) => {
        calls.push({ url, payload: plain(payload) });
        if (url === fail) return { code: -1, msg: '模拟接口失败' };
        if (url === '/api/sqlite/flushTransaction') return success(null);
        if (url === '/api/block/getBlockDOM') return success({ dom: 'document-dom' });
        if (url === '/api/query/sql') {
            const stmt = payload.stmt;
            if (/select \* from blocks/i.test(stmt)) {
                return success(blocks.filter(block => block.id === stmt.match(/id\s*=\s*'([^']+)'/)[1]));
            }
            assert.match(stmt, /SELECT id, path FROM blocks/);
            const ids = new Set([...stmt.match(/id IN \(([^)]+)\)/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]));
            let result = blocks.filter(block => block.type === 'd' && ids.has(block.id));
            const exclusion = stmt.match(/path NOT LIKE '%\/([^/]+)\/%'/);
            if (exclusion) result = result.filter(block => block.id !== 'parent' && !block.path.includes(`/${exclusion[1]}/`));
            const inclusion = stmt.match(/AND path LIKE '%\/([^/]+)\/%'/);
            if (inclusion) result = result.filter(block => block.path.includes(`/${inclusion[1]}/`));
            return success([...result].reverse());
        }
        if (url === '/api/filetree/moveDocsByID') {
            const parent = blocks.find(block => block.id === payload.toID);
            for (const id of payload.fromIDs) {
                blocks.find(block => block.id === id).path = `${parent.path.replace(/\.sy$/, '')}/${id}.sy`;
            }
            return success(null);
        }
        if (url === '/api/filetree/listDocsByPath') {
            assert.equal(payload.sort, 6);
            assert.equal(payload.showHidden, true);
            assert.equal(payload.maxListCount, 0);
            const directory = payload.path.replace(/\.sy$/, '');
            return success({ files: blocks.filter(block => block.type === 'd' &&
                block.path.slice(0, block.path.lastIndexOf('/')) === directory) });
        }
        if (url === '/api/filetree/setSort') return success({ docIDs: payload.docSorts.map(doc => doc.id) });
        throw new Error(`非预期接口：${url}`);
    };
    const siyuan = { Plugin: class {}, fetchSyncPost, showMessage: (...args) => messages.push(args) };
    let api;
    function load(name) {
        const exports = {};
        vm.runInNewContext(sources.get(name), {
            exports,
            Error,
            require: name => name === 'siyuan' ? siyuan : name === './api' ? api : {},
            console: { error() {} },
            document: {
                createElement: () => ({
                    // 宿主 DOM 按正文顺序提供节点，包含同段落、列表及折叠内容里的引用。
                    content: { querySelectorAll: () => references.map(id => ({ getAttribute: () => id })) },
                }),
            },
        }, { filename: `${name}.js` });
        return exports;
    }
    api = load('api');
    const plugin = new (load('index').default)();
    plugin.i18n = i18n;
    plugin.showLoadingDialog = () => { plugin.loading = true; };
    plugin.closeLoadingDialog = () => { plugin.loading = false; };
    return {
        plugin, calls, messages,
        sorts: () => calls.filter(call => call.url.endsWith('/setSort')).map(call => call.payload.docSorts),
        moves: () => calls.filter(call => call.url.endsWith('/moveDocsByID')).map(call => call.payload.fromIDs),
    };
}

function expectedSort(ids) {
    return ids.map((id, index) => ({ id, sort: index + 1 }));
}

test('全文移动排序依照首次引用顺序，排除重复引用和普通块', async () => {
    const f = fixture({ references: ['beta', 'alpha', 'beta', 'paragraph', 'existing', 'ancestor', 'parent'] });
    await f.plugin.moveAndSortReferencedDocs('parent');
    assert.deepEqual(f.moves(), [['beta', 'alpha']]);
    assert.deepEqual(f.sorts(), [expectedSort(['keep-b', 'keep-a', 'beta', 'alpha', 'existing'])]);
    assert.equal(f.plugin.loading, false);
});

test('选中块只移动排序指定引用，正文的其他引用不参与', async () => {
    const f = fixture();
    await f.plugin.moveAndSortReferencedDocs('parent', ['alpha', 'alpha', 'beta']);
    assert.deepEqual(f.moves(), [['alpha', 'beta']]);
    assert.deepEqual(f.sorts(), [expectedSort(['existing', 'keep-b', 'keep-a', 'alpha', 'beta'])]);
    assert.equal(f.calls.some(call => call.url.endsWith('/getBlockDOM')), false);
});

test('数据库排序保留视图行顺序并去重', async () => {
    const f = fixture();
    await f.plugin.moveAndSortReferencedDocs('parent', ['alpha', 'existing', 'beta', 'alpha'], true);
    assert.deepEqual(f.sorts(), [expectedSort(['keep-b', 'keep-a', 'alpha', 'existing', 'beta'])]);
});

test('仅排序不移动外部文档，也不处理更深层的子文档', async () => {
    const f = fixture({ references: ['beta', 'nested-b', 'existing', 'alpha'] });
    await f.plugin.moveAndSortReferencedDocs('parent', undefined, false, true);
    assert.deepEqual(f.moves(), []);
    assert.deepEqual(f.sorts(), [expectedSort(['keep-b', 'keep-a', 'existing'])]);
});

test('空选择不扩大到全文且不写排序', async () => {
    const f = fixture();
    await f.plugin.moveAndSortReferencedDocs('parent', []);
    assert.deepEqual(f.moves(), []);
    assert.deepEqual(f.sorts(), []);
    assert.equal(f.messages.at(-1)[0], i18n.noDocsProcessed);
});

test('多层级按正文顺序分别排序各组兄弟文档', async () => {
    const f = fixture({ references: ['nested-b', 'keep-a', 'nested-a', 'keep-b', 'nested-b'] });
    await f.plugin.multiLevelSort('parent');
    assert.deepEqual(f.sorts(), [
        expectedSort(['nested-b', 'nested-a']),
        expectedSort(['existing', 'keep-a', 'keep-b']),
    ]);
    assert.deepEqual(f.moves(), []);
});

for (const endpoint of ['moveDocsByID', 'setSort']) {
    test(`${endpoint} 失败时关闭进度弹窗并提示错误`, async () => {
        const f = fixture({ fail: `/api/filetree/${endpoint}` });
        await f.plugin.moveAndSortReferencedDocs('parent');
        assert.equal(f.plugin.loading, false);
        assert.equal(f.messages.at(-1)[0], '模拟接口失败');
        assert.equal(f.messages.at(-1)[2], 'error');
        if (endpoint === 'moveDocsByID') assert.deepEqual(f.sorts(), []);
    });
}
