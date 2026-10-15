const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../厂长.js'), 'utf8');
const functionNames = [
    'normalizeUrl', 'chineseNumberToInt', 'extractEpisodeNumber',
    'getCurrentEpisodeLinkFromDocument', 'getCurrentEpisodeLabelFromDocument',
    'getCurrentEpisodeNumberFromDocument', 'getNextEpisodeInfo', 'navigateToNextEpisode',
    'sendNextEpisodeNavigateRequest', 'activateNextEpisodeButton', 'ensureNextEpisodeButton'
];
const functions = functionNames.map(name => {
    let start = source.indexOf(`    async function ${name}(`);
    if (start < 0) start = source.indexOf(`    function ${name}(`);
    const end = source.indexOf('\n    }', start) + '\n    }'.length;
    assert.ok(start >= 0 && end > start, `找到函数 ${name}`);
    return source.slice(start, end);
}).join('\n');

const episodes = [
    ['/v_play/1.html', '第1集'],
    ['/v_play/2.html', '第2集'],
    ['/v_play/3.html', '第3集'],
];
function setup(groups, currentUrl) {
    const links = groups.flatMap(group => {
        const list = { querySelectorAll: () => episodes };
        const episodes = group.map(([url, label, active = false]) => ({
            href: new URL(url, 'https://www.4kcz.com').href,
            textContent: label,
            classList: { contains: () => active },
            closest: () => list,
            getAttribute: () => '',
        }));
        return episodes;
    });
    const messages = [];
    let button;
    const controls = {
        querySelector: selector => selector === '.cz-history-next-episode' ? button : null,
        appendChild: node => { button = node; },
    };
    const context = vm.createContext({
        URL,
        location: { href: `https://www.4kcz.com${currentUrl}` },
        window: { top: { postMessage: message => messages.push(message) }, location: {} },
        document: {
            querySelectorAll: () => links,
            createElement: () => ({
                style: {}, attrs: {}, events: {},
                setAttribute(key, value) { this.attrs[key] = value; },
                getAttribute(key) { return this.attrs[key]; },
                querySelector: () => ({}),
                addEventListener(type, listener) { this.events[type] = listener; },
            }),
        },
        querySelectorAllDeep: () => [controls],
        throttledLog() {}, warn() {}, recordCurrentPlayPage() {},
        fetchTextWithTimeout: async () => '',
        extractPlayerUrlFromPlayHtml: () => '',
        updatePlaylistHighlight() {}, sendNextEpisodeInfo() {},
        history: { replaceState() {} },
        CONFIG: { NEXT_EPISODE_NAVIGATE_MESSAGE: 'next' },
        iframeNextEpisodeUrl: '', iframeNextEpisodeLabel: '',
        iframeNextEpisodeSwitching: false,
        iframeLastNextClickAt: 0,
    });
    vm.runInContext(functions, context);
    return { context, messages, getButton: () => button };
}

test('特别篇保留播放列表原始名称，不显示为前一集编号', () => {
    const groups = [[
        ['/v_play/124.html', '124'],
        ['/v_play/a-up.html', '虚天战纪-A-上'],
        ['/v_play/a-down.html', '虚天战纪-A-下'],
        ['/v_play/125.html', '125'],
    ]];
    const { context } = setup(groups, '/v_play/a-down.html');
    assert.equal(context.getCurrentEpisodeLabelFromDocument(), '虚天战纪-A-下');
    assert.equal(context.getCurrentEpisodeNumberFromDocument(), 0);
});

test('普通集数返回当前线路下一集，并允许跳转', async () => {
    const { context } = setup([episodes], '/v_play/2.html');
    const info = context.getNextEpisodeInfo();
    assert.equal(info.url, 'https://www.4kcz.com/v_play/3.html');
    assert.equal(info.label, '第3集');
    await context.navigateToNextEpisode(info.url);
    assert.equal(context.window.location.href, info.url);
});

test('最后一集不会跨线路跳到第一集，主站也拒绝跳转请求', async () => {
    const { context } = setup([episodes, [['/v_play/other-1.html', '第1集']]], '/v_play/3.html');
    assert.equal(context.getNextEpisodeInfo().url, '');
    await context.navigateToNextEpisode('https://www.4kcz.com/v_play/other-1.html');
    assert.equal(context.window.location.href, undefined);
});

test('单集、列表尾部回到第一集、重复当前集均无下一集', () => {
    for (const group of [
        [episodes[0]],
        [...episodes, ['/v_play/restart.html', '第1集']],
        [...episodes, ['/v_play/3.html#duplicate', '第3集']],
    ]) {
        const current = group.length === 1 ? '/v_play/1.html' : '/v_play/3.html';
        assert.equal(setup([group], current).context.getNextEpisodeInfo().url, '');
    }
});

test('优先按当前 URL 定位，不受其他线路的高亮影响', () => {
    const { context } = setup([
        [['/v_play/other-1.html', '第1集', true], ['/v_play/other-2.html', '第2集']],
        episodes,
    ], '/v_play/3.html');
    assert.equal(context.getNextEpisodeInfo().url, '');
});

test('URL 不匹配时仍支持 pbplay 高亮；无法定位时无下一集', () => {
    const { context } = setup([[['/v_play/1.html', '第1集', true], episodes[1]]], '/alias.html');
    assert.equal(context.getNextEpisodeInfo().url, 'https://www.4kcz.com/v_play/2.html');
    assert.equal(setup([episodes], '/unknown.html').context.getNextEpisodeInfo(), null);
    assert.equal(setup([], '/unknown.html').context.getNextEpisodeInfo(), null);
});

test('没有下一集时按钮置灰，鼠标及键盘都不发送跳转请求', () => {
    const { context, messages, getButton } = setup([], '/v_play/1.html');
    context.ensureNextEpisodeButton();
    const button = getButton();
    assert.ok(button);
    assert.equal(button.attrs['aria-disabled'], 'true');
    assert.equal(button.attrs.tabindex, '-1');
    assert.equal(button.title, '暂无下一集');
    assert.equal(button.style.opacity, '0.35');
    const event = { preventDefault() {}, stopPropagation() {} };
    const activate = () => {
        button.events.click(event);
        for (const key of ['Enter', ' ']) button.events.keydown({ ...event, key });
    };
    activate();
    assert.equal(messages.length, 0);

    context.iframeNextEpisodeUrl = 'https://www.4kcz.com/v_play/2.html';
    context.iframeNextEpisodeLabel = '第2集';
    context.ensureNextEpisodeButton();
    assert.equal(getButton(), button);
    assert.equal(button.attrs['aria-disabled'], 'false');
    assert.equal(button.attrs.tabindex, '0');
    assert.equal(button.style.opacity, '1');
    assert.equal(button.title, '下一集 第2集');
    activate();
    assert.equal(messages.length, 1); // 连续触发被防重入拦住，只发送一次

    context.iframeLastNextClickAt = 0;
    button.events.keydown({ ...event, key: 'Enter' });
    assert.equal(messages.length, 2);

    context.iframeLastNextClickAt = 0;
    button.events.keydown({ ...event, key: ' ' });
    assert.equal(messages.length, 3);

    context.iframeNextEpisodeUrl = '';
    context.ensureNextEpisodeButton();
    assert.equal(getButton(), button);
    assert.equal(button.attrs['aria-disabled'], 'true');
    context.iframeLastNextClickAt = 0;
    activate();
    assert.equal(messages.length, 3);
});
