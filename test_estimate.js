/* ============================================================
 * GG 施工费测算 · 回归语料一键测试
 * 用法：node test_estimate.js    （零依赖，只读源文件，不改动任何项目文件）
 *
 * 目的：把 2026-11-22 修过的真实输入/口径固化成断言，防止内核改动后
 *       同类 bug 复发（大写 X、面积吃默认值、单行多物品丢项、单位表、
 *       同义词绑定、老配置迁移、按公里运费、历史索引 -1 等）。
 * 测试对象：直接加载 estimate.js 和 app.js 里的真实函数切片，不重写逻辑。
 * ============================================================ */
const fs = require('fs');
const vm = require('vm');
const path = require('path');

let PASS = 0, FAIL = 0;
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function ck(group, name, cond, extra) {
  if (cond) { PASS++; console.log(`  ✓ ${group} ${name}`); }
  else { FAIL++; console.log(`  ✗ ${group} ${name}${extra !== undefined ? '  → ' + extra : ''}`); }
}
function ids(t, opts) { return (E.parseSpec(t, opts) || []).map((x) => [x.id, x.q]); }
function first(t, opts) { return ids(t, opts)[0] || []; }

const ROOT = __dirname;
const estSrc = fs.readFileSync(path.join(ROOT, 'estimate.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// ---------- 内核上下文（原样加载 estimate.js）----------
const ec = { window: {}, document: {}, console };
vm.createContext(ec);
vm.runInContext(estSrc, ec);
const E = ec.window.Estimate;

// ---------- GG 层上下文（真实函数切片 + 最小 mock）----------
const slice = (a, b) => {
  const i = appSrc.indexOf(a);
  if (i < 0) throw new Error('切片起点未找到: ' + a);
  const j = appSrc.indexOf(b, i);
  if (j < 0) throw new Error('切片终点未找到: ' + b);
  return appSrc.slice(i, j);
};
const parts = [
  'let _estimateCfg = null; let _estUI = null;',
  appSrc.slice(appSrc.indexOf('function esc(str)'), appSrc.indexOf('\n}', appSrc.indexOf('function esc(str)')) + 2),
  slice('function estCfg()', '/* 从 app_settings'),
  slice('function normalizeEstimateConfig(cfg)', '/* ===== 施工项增删'),
  slice('function estParseWithCustom(txt)', '/* 智能拆解模糊候选'),
  slice('const EST_UNKNOWN_KEY =', 'function estAddCandidates()'),
  slice('function estItemOptionsHtml(selected)', 'async function estOpenUnknownDrawer'),
  slice('function estCalcCtx(height, wall)', '/* 生成测算快照'),
  slice('function buildCostEstimate(work, result, ctx, items)', '/* ---------- 测算器 UI'),
  slice('const EST_HISTORY_KEY =', 'function estOpenHistory()'),
  slice('function estComboHits(combo, dims)', '/* 整套方案内容覆盖评分'),
  slice('function estCatalog()', 'let _estCatEdit'),
  slice('function estCatalogTextHits(txt)', '/* 整套方案 → 清单项'),
  slice('function cardWorkContentText(wc, note)', '/* 渲染「施工内容 + 注意事项'),
].join('\n');
const store = new Map();
const els = {
  estResult: { innerHTML: '' }, estHistList: { innerHTML: '' },
  estDrawerSummary: { textContent: '' }, estDistanceKm: { value: '0' }, estDistAmt: { textContent: '' },
};
const gc = {
  window: { Estimate: E }, Estimate: E, document: { getElementById: (id) => els[id] || null }, console,
  localStorage: {
    getItem: (k) => store.has(k) ? store.get(k) : null,
    setItem: (k, v) => store.set(k, v),
    removeItem: (k) => store.delete(k),
  },
  safeJsonParse: (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } },
  toast: () => {}, estCanManage: () => true, estCfgHubTabs: (t) => '<tabs:' + t + '>',
  estShowDrawer: (t, h) => { gc.__drawer = { t, h }; },
  saveEstimateConfig: async () => { gc.__saves = (gc.__saves || 0) + 1; return true; },
  estCatalogPriceFor: () => null,
  normalizeWorkItems: (x) => x || [],
  fmtEstMoney: (n) => '¥' + (Number(n) || 0).toFixed(2),
  fmtEstHours: (n) => (Math.round((Number(n) || 0) * 10) / 10).toFixed(1),
  currentProfile: null,
};
vm.createContext(gc);
vm.runInContext(parts, gc);

console.log('\n=== A. 内核解析：真实历史输入 ===');
ck('A', '大写 X 尺寸解析', E.parseSize('60X90CM').area === 0.54, JSON.stringify(E.parseSize('60X90CM')));
ck('A', '大写 X 整句面积', eq(first('贴画面 尺寸60X90CM 5个'), ['i_printchange', 2.7]), JSON.stringify(ids('贴画面 尺寸60X90CM 5个')));
ck('A', '小写 x 面积不回归', eq(first('贴画面 60x90cm 5个'), ['i_printchange', 2.7]));
ck('A', '指引牌→易拉宝摆放', first('室外指引牌5套')[0] === 'i_easel');
ck('A', '引导牌同义词', first('引导牌35张')[0] === 'i_easel');
ck('A', '水牌同义词', first('水牌2个')[0] === 'i_easel');
ck('A', '胸牌→桌牌', first('胸牌证件20个')[0] === 'i_deskcard');
ck('A', '胸卡/工作牌同义词', first('胸卡10个')[0] === 'i_deskcard' && first('工作牌3个')[0] === 'i_deskcard');
ck('A', '条幅按条不按㎡', eq(first('悬挂条幅70x800cm 1条'), ['i_bannerhang', 1]), JSON.stringify(ids('悬挂条幅70x800cm 1条')));
ck('A', '单行两物品都识别', eq(ids('指引牌 5套 引导牌 35张'), [['i_easel', 5], ['i_easel', 35]]), JSON.stringify(ids('指引牌 5套 引导牌 35张')));
// 2026-11-24 口径调整：「发光字 N个」是字数 → i_ledz（按字），不再把 3 当 3㎡ 的 i_led
ck('A', '单行三物品都识别（发光字按字）', eq(ids('门头5套 发光字3个 指引牌2套'), [['i_door', 5], ['i_ledz', 3], ['i_easel', 2]]), JSON.stringify(ids('门头5套 发光字3个 指引牌2套')));
ck('A', '数量后尺寸留本段', eq(ids('贴画面5张60X90CM 指引牌3个'), [['i_printchange', 2.7], ['i_easel', 3]]), JSON.stringify(ids('贴画面5张60X90CM 指引牌3个')));
ck('A', '逗号分行不回归', ids('指引牌 5套，引导牌 35张').length === 2);
ck('A', '换行分行不回归', ids('指引牌 5套\n引导牌 35张').length === 2);
ck('A', '同词重复不双计', ids('门头焊接，门头打胶').filter((x) => x[0] === 'i_door').length === 1, JSON.stringify(ids('门头焊接，门头打胶')));
ck('A', '门头配方仍多item展开', (E.tryDoorRecipe('2.8米×4米铝塑板门头', {}) || { hits: [] }).hits.length >= 5);
ck('A', '门头面积11.2㎡', eq(first('2.8米×4米铝塑板门头'), ['i_door', 11.2]));
const doorBare = E.tryDoorRecipe('门头 6米×2米', {});
const doorChar = E.tryDoorRecipe('门头 6米×2米 发光字4个 字高60厘米', {});
ck('A', '未写字数标记暂估', doorBare.charQty == null, String(doorBare.charQty));
ck('A', '字数/字高能识别', doorChar.charQty === 4 && Math.abs(doorChar.charH - 0.6) < 1e-9, JSON.stringify([doorChar.charQty, doorChar.charH]));
const aluRow = (doorBare.hits || []).find((h) => h.n === '铝塑板') || {};
ck('A', '铝塑板按整张6张计价', aluRow.q === 17.88 && aluRow.sheets === 6, JSON.stringify([aluRow.q, aluRow.sheets]));
const doorFlat = E.tryDoorRecipe('门头 6米×2米', { depth: 0 });
ck('A', '侧包深度0=贴墙5张', ((doorFlat.hits || []).find((h) => h.n === '铝塑板') || {}).sheets === 5);
// 「2.8米*4米的门头，4个55厘米高的发光字」：4 个属于发光字，不能把门头整体 ×4
const doorMix = E.tryDoorRecipe('2.8米*4米的门头，4个55厘米高的发光字', {}) || { hits: [] };
const ledMix = (doorMix.hits.find((h) => h.id === 'i_led') || {}).q;
ck('A', '门头数量不吞发光字个数', !doorMix.hits.some((h) => h.type === 'lib' && Math.abs((Number(h.q) || 0) - 44.8) < 0.1), JSON.stringify(doorMix.hits.map((h) => [h.id, h.q])));
ck('A', '发光字按字数×字高²算量', ledMix != null && Math.abs(ledMix - 1.21) < 0.011, String(ledMix));
// 电源只带 12V 负载：灯带/射灯默认 220V 直供，不占电源；改成 12V 才计入
const doorPow = E.tryDoorRecipe('3.5米*1.5米的门头，8个60厘米高的发光字', {}) || { hits: [] };
const psu220 = (doorPow.hits.find((h) => h.n === 'LED电源') || {}).q;
ck('A', '灯带/射灯220V不占12V电源', psu220 === 1, String(psu220));
const doorPow12 = E.tryDoorRecipe('3.5米*1.5米的门头，8个60厘米高的发光字',
  { params: { ...E.WORK_PARAM_DEFAULT, stripVolt: 12, spotVolt: 12 } }) || { hits: [] };
const psu12 = (doorPow12.hits.find((h) => h.n === 'LED电源') || {}).q;
ck('A', '灯带/射灯接12V时计入电源', psu12 === 2, String(psu12));
const wireQ = (doorPow.hits.find((h) => h.n && h.n.indexOf('电线') >= 0) || {}).q;
ck('A', '门头自动估算电线米数', wireQ >= 10, String(wireQ));
// 树状并联：6×2m门头 + 6字 ≈ 干线9m + 字引线3.6m + 射灯4.8m + 灯带端接2m = 19.4m ×1.1 ≈ 22m（不是每字整根）
const doorWire = E.tryDoorRecipe('6米*2米的门头，6个60厘米高的发光字', {}) || { hits: [] };
const wire22 = (doorWire.hits.find((h) => h.n && h.n.indexOf('电线') >= 0) || {}).q;
ck('A', '电线按树状并联估算', wire22 === 22, String(wire22));
ck('A', '精神堡垒专项', first('精神堡垒8米高')[0] === 'i_monument');
ck('A', '默认整套方案≥21套（含工地大门/围挡/宣传物料/展厅）', (E.SCENE_COMBOS || []).length >= 21, String((E.SCENE_COMBOS || []).length));

console.log('\n=== B. 整套方案：面积口径 + 老配置兼容 ===');
const comboNew = (E.SCENE_COMBOS || []).find((c) => c.n === '停车场导视牌整套');
const comboOld = { n: '停车场导视牌整套', ids: ['i_pitbase', 'i_guide', 'i_printchange'], q: { i_pitbase: 1, i_guide: 1, i_printchange: 3 } };
const dims = E.parseDims('停车场交通指示牌5个 挖坑 栽立柱 贴画面 尺寸60X90CM');
const calcCombo = (c) => {
  const hits = gc.estComboHits(c, dims);
  hits.forEach((h) => { h.q = Math.round(h.q * 5 * 1000) / 1000; });
  return hits;
};
const hNew = calcCombo(comboNew), hOld = calcCombo(comboOld);
const areaQ = (hs) => (hs.find((h) => h.id === 'i_printchange') || {}).q;
ck('B', '新模板画面2.7㎡', areaQ(hNew) === 2.7, JSON.stringify(hNew.map((h) => [h.id, h.q])));
ck('B', '老配置无m字段也2.7㎡', areaQ(hOld) === 2.7, String(areaQ(hOld)));
ck('B', '挖坑/指示牌仍按个', (hNew[0] || {}).q === 5 && (hNew[1] || {}).q === 5, JSON.stringify(hNew.map((h) => h.q)));

console.log('\n=== C. 配置兼容：运输单位迁移 + 同义词清洗 ===');
const norm = gc.normalizeEstimateConfig({
  prices: { transport: 200 },
  catalog: [{ cat: '⑨ 运输/杂费', desc: '', rows: [
    { id: 'calc:transport', n: '市内运输', p: 200, u: '元/趟', note: '30km内' },
    { id: 't_cross', n: '跨区/夜间进场', p: 300, u: '元/趟', note: '' },
    { id: 'x_other', n: '别的价', p: 200, u: '元/趟', note: '' },
  ] }],
  synonyms: { ' 围挡 ': 'i_steel', '': 'i_led', 'x': '' },
});
ck('C', '老transport 200→2', norm.prices.transport === 2, String(norm.prices.transport));
const nrows = norm.catalog[0].rows;
ck('C', '老单价库运输行迁移', nrows[0].p === 2 && nrows[0].u === '元/公里' && nrows[1].p === 2 && nrows[1].u === '元/公里');
ck('C', '无关单价不误伤', nrows[2].p === 200 && nrows[2].u === '元/趟');
ck('C', '自定义低于50保留', gc.normalizeEstimateConfig({ prices: { transport: 3.5 } }).prices.transport === 3.5);
ck('C', '同义词键清洗', eq(norm.synonyms, { '围挡': 'i_steel' }), JSON.stringify(norm.synonyms));

console.log('\n=== D. 同义词绑定：写入→立即可识别→删除回退 ===');
(async () => {
  const cfg = gc.estCfg();
  cfg.synonyms = {};
  gc.estUnknownLog('室外围挡制作', false);
  gc.estOpenUnknownDrawer();
  ck('D', '未识别词抽屉有绑定控件', gc.__drawer.h.includes('id="estUkW0"') && gc.__drawer.h.includes('id="estUnS0"'));
  els.estUkW0 = { value: '围挡' }; els.estUnS0 = { value: 'i_steel' };
  await gc.estUnknownBind(0);
  ck('D', '绑定写配置+移除记录', cfg.synonyms['围挡'] === 'i_steel' && JSON.parse(store.get('gg_est_unknown_v1') || '[]').length === 0);
  ck('D', '绑定后立即识别', eq(gc.estParseWithCustom('围挡施工3米').map((x) => x.id), ['i_steel']));
  cfg.synonyms['水牌架'] = 'i_posterrack';
  ck('D', '配置词覆盖默认词典', first('水牌架2个', { synonyms: cfg.synonyms })[0] === 'i_posterrack');
  delete cfg.synonyms['水牌架'];
  ck('D', '删除后回退默认', first('水牌架2个', { synonyms: cfg.synonyms })[0] === 'i_easel');

  console.log('\n=== E. 运输按公里 + 起步价串联 ===');
  const p = Object.assign({}, E.WORK_PARAM_DEFAULT);
  const work = [{ id: 'i_guide', q: 1 }];
  const r30 = E.calculate(work, { params: p, height: 'low', wall: 'flat', distanceKm: 30, transportRate: 2, quote: 220 });
  ck('E', '30公里=60元', r30.transportFee === 60 && r30.construction === 300, JSON.stringify({ fee: r30.transportFee, c: r30.construction }));
  // 起步价按「人工行实算金额 + 运费」补足（i_guide 已改为安装技工 48 元/时，不再用 0.8×rateNormal 硬编码）
  ck('E', '起步价补足串联', Math.abs(r30.floor - (300 - (r30.rows[0].fee + 60))) < 0.01 && r30.compare.diff === -80, JSON.stringify({ floor: r30.floor, diff: r30.compare.diff }));
  ck('E', '小数公里不取整错', E.calculate(work, { params: p, distanceKm: 12.5, transportRate: 2 }).transportFee === 25);
  const p0 = Object.assign({}, p, { minStart: 0 });
  ck('E', 'minStart=0关闭起步价', E.calculate(work, { params: p0 }).floor === 0);
  ck('E', '报价单含运输行', E.quoteText(Object.assign({}, r30, { distanceKm: 30, transportRate: 2 }), {}).includes('运输费：¥60'));

  console.log('\n=== F. 金额链隔离 + 施工内容文本 ===');
  const snap = gc.buildCostEstimate(work, r30, { distanceKm: 30 }, []);
  const snapKeys = Object.keys(snap);
  ck('F', '快照不写工程金额/工费/池', !snapKeys.some((k) => /projectAmount|laborFee|commission|pool/i.test(k)), snapKeys.join(','));
  const split = (v) => (v || '').split(/[、,，\s]+/).map((s) => s.trim()).filter(Boolean);
  ck('F', '施工内容多行拆分', eq(split('门头钢架焊接、发光字制作\nLED屏安装 3面'), ['门头钢架焊接', '发光字制作', 'LED屏安装', '3面']));

  console.log('\n=== G. 历史索引（indexOf -1 bug 不复活）===');
  store.set('gg_estimate_history_v1', JSON.stringify([
    { id: 1, name: '第一条', at: '2026-11-22 10:00', work: [], total: 100, hours: 1, height: 'low', wall: 'flat', quote: '' },
    { id: 2, name: '第二条', at: '2026-11-22 11:00', work: [], total: 200, hours: 2, height: 'low', wall: 'flat', quote: '' },
  ]));
  gc.estRenderHistList();
  ck('G', '全量列表索引0/1', els.estHistList.innerHTML.includes('estLoadHistory(0)') && els.estHistList.innerHTML.includes('estLoadHistory(1)'));
  gc.estFilterHistory('第二条');
  ck('G', '过滤后仍用原索引1', els.estHistList.innerHTML.includes('estLoadHistory(1)') && !els.estHistList.innerHTML.includes('estLoadHistory(0)'));
  ck('G', '过滤后复制按钮同索引', els.estHistList.innerHTML.includes('estCopyHistory(1)'));
  gc.estFilterHistory('');

  console.log('\n=== H. 口径修复：高空单价/包干/人天/设备/往返/辅材/对比 ===');
  const pq = Object.assign({}, E.WORK_PARAM_DEFAULT, { minStart: 0 });
  const rLowDoor = E.calculate([{ id: 'i_door', q: 10 }], { params: pq, height: 'low', wall: 'flat' });
  const rMidDoor = E.calculate([{ id: 'i_door', q: 10 }], { params: pq, height: 'mid', wall: 'flat' });
  // 工种分价（2026-11）后：门头整体按安装技工 48，中空改高空 75，比值≈75/48×1.15≈1.8（原来普工36→75 是 2 倍）
  ck('H', '受高项中空按高空价', rMidDoor.labor > rLowDoor.labor * 1.5 && rMidDoor.labor < rLowDoor.labor * 2.5, `${rLowDoor.labor} → ${rMidDoor.labor}`);
  const rCarpetMid = E.calculate([{ id: 'i_carpet', q: 100 }], { params: pq, height: 'mid', wall: 'flat' });
  ck('H', '地面项不吃高空价', rCarpetMid.labor === 100 * 0.12 * pq.rateNormal, String(rCarpetMid.labor));
  const lump = E.resolveItem({ cid: 'c1', mode: 'lump', amt: 5000, n: '包干' }, { params: pq, height: 'high' });
  ck('H', '包干价不计工时', lump.hours === 0 && lump.fee === 5000, JSON.stringify({ h: lump.hours, f: lump.fee }));
  const pH = Object.assign({}, pq, { dayHours: 7 });
  const rH = E.calculate([{ id: 'i_door', q: 10 }], { params: pH, height: 'low', wall: 'flat' });
  ck('H', '人天用dayHours而非硬编码8', Math.abs(rH.days - rH.totalHours / 7) < 1e-9, String(rH.days));
  const rEq = E.calculate([{ id: 'i_door', q: 40 }], { params: pq, height: 'mid', wall: 'flat' });
  ck('H', '设备天数自动跟工期', rEq.equipDays >= 2 && rEq.equip === pq.equipMid * rEq.equipDays, JSON.stringify({ d: rEq.equipDays, e: rEq.equip }));
  const rRt = E.calculate([], { params: pq, distanceKm: 10, transportRate: 2, roundTrip: true });
  ck('H', '运输往返×2', rRt.transportFee === 40, String(rRt.transportFee));
  const rAux = E.calculate([{ kind: 'mat', n: '材料', u: '项', q: 10, p: 100 }], { params: pq, quote: 1000 });
  ck('H', '辅材费 6% 生效', rAux.auxFee === 60 && rAux.grand === rAux.construction + 1060, JSON.stringify({ aux: rAux.auxFee, g: rAux.grand }));
  ck('H', '对比默认含材料(合计)', rAux.compare.baseLabel === 'grand' && rAux.compare.diff === 1000 - rAux.grand);
  const rAuxC = E.calculate([{ kind: 'mat', n: '材料', u: '项', q: 10, p: 100 }], { params: pq, quote: 1000, compareBase: 'construction' });
  ck('H', '对比口径可切施工费', rAuxC.compare.baseLabel === 'construction' && rAuxC.compare.diff === 1000 - rAuxC.construction);

  console.log('\n=== I. 智能拆解：原文保留 + 防重复累加 ===');
  const parseFn = slice('function estSmartParse(', '\n/* 添加一个施工项到清单');
  const pIn = { value: '指示牌 3套' };
  const pToasts = [];
  const pc = {
    Estimate: E, window: { Estimate: E }, console,
    document: { getElementById: (id) => id === 'estInput' ? pIn : id === 'estDistanceKm' ? { value: '' } : null },
    toast: (m) => pToasts.push(m),
    estCfg: () => ({ door: {}, synonyms: {} }),
    estCombos: () => [], estComboCoverScore: () => ({ hits: 0, total: 0 }), estComboHits: () => [],
    estComboMatches: () => ({ exact: [], cover: [] }), estOpenComboChoice: () => {},
    estOpenParseModeChoice: (t) => { pc._estOpenChoice = t; },
    estSpecialHits: () => ({ hits: [], spec: { label: '' } }),
    estParseWithCustom: (t) => [{ id: 'i_t', n: t, u: '项', q: 1 }],
    estFuzzyCandidates: () => [], estUnknownLog: () => {},
    estAddWork: (w) => pc._estUI.work.push(w), estAutoMaterialHits: () => [], estAutoLinkEquip: () => [],
    renderEstimateWorkList: () => {}, estDistanceChange: () => {}, estRecalc: () => {},
    fmtEstMoney: (n) => '¥' + (Number(n) || 0).toFixed(2), confirm: () => true,
    _estUI: { work: [], lastParsedText: '', distanceKm: 0, roundTrip: false },
  };
  vm.createContext(pc);
  vm.runInContext(parseFn, pc);
  pc.estSmartParse();
  ck('I', '首次拆解生成1项', pc._estUI.work.length === 1, String(pc._estUI.work.length));
  ck('I', '拆解后原文保留', pIn.value === '指示牌 3套', pIn.value);
  ck('I', '提示原文已保留', /原文已保留/.test(pToasts[pToasts.length - 1]));
  pc.estSmartParse();
  ck('I', '同文本重复点不累加', pc._estUI.work.length === 1, String(pc._estUI.work.length));
  pIn.value = '指示牌 4套';
  pc.estSmartParse();
  ck('I', '改字后先问累加还是重算，不偷偷累加',
    pc._estOpenChoice === '指示牌 4套' && pc._estUI.work.length === 1, String(pc._estUI.work.length));
  pc.window._estParseForced = '指示牌 4套';
  pc.estSmartParse();
  ck('I', '用户选累加后才追加（改字后可再拆解）', pc._estUI.work.length === 2, String(pc._estUI.work.length));

  console.log('\n=== J. 门头工艺参数：贴墙侧包 + 暂估提示入口 ===');
  const nd = gc.normalizeEstimateConfig({ door: { depth: 0, gap: 0.5, thick: 0.3, shape: 'bad' } });
  ck('J', '侧包深度0保留', nd.door.depth === 0, String(nd.door.depth));
  ck('J', '非法造型回退矩形', nd.door.shape === 'rect', nd.door.shape);
  ck('J', '骨架厚度保留', nd.door.thick === 0.3, String(nd.door.thick));
  ck('J', '参数面板有侧包入口', appSrc.includes('data-est-door="depth"'));
  ck('J', '拆解后有暂估提示DOM', appSrc.includes('id="estGlowHint"'));

  console.log('\n=== K. 定额库：工种分价 + 工时贴近市场（2026-11 重校） ===');
  const P0 = Object.assign({}, E.WORK_PARAM_DEFAULT);
  const TR = E.TRADES || {};
  const items = E.WORK_ITEMS || [];
  ck('K', '全部施工项都有合法工种', items.every((x) => !!TR[x.tr]), items.filter((x) => !TR[x.tr]).map((x) => x.id).join(','));
  ck('K', '全部施工项都有施工方式', items.every((x) => String(x.m || '').trim().length >= 4), items.filter((x) => String(x.m || '').trim().length < 4).map((x) => x.id).join(','));
  const priceOf = (id) => E.itemUnitPrice(E.getWorkItem(id), P0);
  const inRange = (id, lo, hi) => { const v = priceOf(id); return v >= lo && v <= hi; };
  ck('K', '门头整体落在 100–150 元/㎡', inRange('i_door', 100, 150), priceOf('i_door').toFixed(1));
  ck('K', '铝塑板面板落在 25–50 元/㎡', inRange('i_fascia', 25, 50), priceOf('i_fascia').toFixed(1));
  ck('K', '钢架焊接落在 50–90 元/㎡', inRange('i_steel', 50, 90), priceOf('i_steel').toFixed(1));
  ck('K', '发光字安装落在 60–120 元/㎡', inRange('i_led', 60, 120), priceOf('i_led').toFixed(1));
  ck('K', '指示牌落在 80–150 元/个', inRange('i_guide', 80, 150), priceOf('i_guide').toFixed(1));
  ck('K', '吊篮安拆落在 500–900 元/次', inRange('i_basket', 500, 900), priceOf('i_basket').toFixed(1));
  ck('K', '接线调试落在 200–350 元/组', inRange('i_wire', 200, 350), priceOf('i_wire').toFixed(1));
  ck('K', '焊工单价高于普工', E.tradeRate({ tr: 'hg' }, P0) > E.tradeRate({ tr: 'pg' }, P0));
  ck('K', '缺 tr 的老自定义项按普工', E.tradeRate({}, P0) === P0.rateNormal);
  ck('K', '高空价不低于本工种价', E.tradeRate({ tr: 'az' }, P0) < P0.rateHigh);
  // 门头整套（骨架+面板+字+接线）人工 120–190 元/㎡，接近市场门头安装人工
  const doorSet = E.calculate([
    { id: 'i_steel', q: 11.2 }, { id: 'i_fascia', q: 11.2 }, { id: 'i_led', q: 4.48 }, { id: 'i_wire', q: 1 },
  ], { params: Object.assign({}, P0, { minStart: 0 }), height: 'low', wall: 'flat' });
  const perSqm = doorSet.labor / 11.2;
  ck('K', '门头整套人工 120–190 元/㎡', perSqm >= 120 && perSqm <= 190, perSqm.toFixed(1));
  ck('K', '人工费=工时×工种单价', Math.abs(doorSet.labor - doorSet.rows.reduce((s, x) => s + x.fee, 0)) < 0.01);

  console.log('\n=== L. 施工项管理：改工时/工种单价，折合金额即时联动（2026-11-22） ===');
  ck('L', '内置项工时有 input 事件', appSrc.includes('oninput="estWhInput(this)"'));
  ck('L', '内置项金额有独立节点 data-price', appSrc.includes('data-price="${esc(it.id)}"'));
  ck('L', '自定义项改工时/工种会刷新金额', appSrc.includes('estItemRefreshPrice(i)') && appSrc.includes('data-cprice'));
  ck('L', '施工项页不再重复显示工种单价（只在参数页）', !appSrc.includes('est-rate-line') && !appSrc.includes('est-rate-strip') && !appSrc.includes('estRateInput') && /data-est-param="\$\{k\}"/.test(appSrc));
  ck('L', '施工项页保留去向提示', /工种单价在「参数与单价」页签改/.test(appSrc));
  ck('L', '施工项页有校准工时入口', appSrc.includes('onclick="estOpenWhCalib()"'));
  ck('L', '新增自定义项会聚焦并滚入视野', /function estItemNew\(\)[\s\S]{0,800}scrollIntoView/.test(appSrc));
  ck('L', '保存施工项有单价兜底落库', /async function estSaveItems\(\)[\s\S]{0,300}estCollectRates\(\)/.test(appSrc));
  // 旧默认迁移只跑一次：老配置 30 元/时抬到 36；用户自己设的 30（v:2）必须能存住，
  // 否则表现就是"单价改了又变回默认价"。
  const cfgOld = gc.normalizeEstimateConfig({ params: { rateNormal: 30 } });
  ck('L', '旧默认 30 元/时首次迁移到 36', cfgOld.params.rateNormal === 36, String(cfgOld.params.rateNormal));
  const cfgNew = gc.normalizeEstimateConfig({ v: 2, params: { rateNormal: 30 } });
  ck('L', '用户自己设的 30 元/时能存住（v2 不再迁）', cfgNew.params.rateNormal === 30, String(cfgNew.params.rateNormal));
  ck('L', '迁移后配置带版本号 v=7', cfgOld.v === 7, String(cfgOld.v));
  // 真实函数验证：0.7 工时 × 安装技工 48 = 34；改成 1.4 应立即变 67，且标记为已校准；
  // 把安装技工单价改成 60，同一行应立刻变 42（0.7×60），不用重渲染。
  const rows = [];
  const mkRow = () => {
    const price = { textContent: '', title: '' };
    const cls = new Set();
    const input = {
      value: '0.7', dataset: { tr: 'az', hd: '0.7', u: '㎡' },
      classList: { toggle: (c, on) => (on ? cls.add(c) : cls.delete(c)), contains: (c) => cls.has(c) },
    };
    return { input, price, cls, rowEl: { querySelector: (s) => (s.includes('data-wh') ? input : price) } };
  };
  const wctx = vm.createContext({
    window: { Estimate: E }, Estimate: E, console,
    document: {
      querySelector: (s) => (rows[0] && rows[0].rowEl) || null,
      querySelectorAll: (s) => (s.includes('data-est-param') ? (wctx.__rateEls || []) : (s.includes('.est-item-bi') ? rows.map((r) => r.rowEl) : [])),
    },
    estCfg: () => ({ params: wctx.__p || P0 }),
    estItemDraft: () => [],
  });
  vm.runInContext(slice('function estCollectRates(', 'function estItemNew('), wctx);
  const useRow = (r) => { rows.length = 0; rows.push(r); };
  const r1 = mkRow(); useRow(r1); wctx.estWhInput(r1.input);
  ck('L', '默认工时折合价=34', r1.price.textContent === '≈¥34/㎡', r1.price.textContent);
  const r2 = mkRow(); useRow(r2); r2.input.value = '1.4'; wctx.estWhInput(r2.input);
  ck('L', '工时翻倍后金额即时翻倍=67', r2.price.textContent === '≈¥67/㎡', r2.price.textContent);
  ck('L', '改动后自动标为已校准', r2.cls.has('is-calib'));
  const r3 = mkRow(); useRow(r3); wctx.estWhInput(r3.input);
  ck('L', '改回默认值取消校准标记', !r3.cls.has('is-calib'));
  // 工种单价改了（在参数页保存后）→ 整表折合价跟着变，不再出现"改了单价还是旧价"
  wctx.__p = Object.assign({}, P0, { rateAz: 60 });
  const r4 = mkRow(); useRow(r4); wctx.estItemRefreshAllPrices();
  ck('L', '安装技工改 60 后折合价即时重算=42', r4.price.textContent === '≈¥42/㎡', r4.price.textContent);
  ck('L', '重算后的说明写明新单价', /60 元\/时/.test(r4.price.title), r4.price.title);
  wctx.__p = null;

  console.log('\n=== M. 门头工艺增项：包边 / 檐口 / 雨棚 / 自定义（2026-11-22） ===');
  const dcfg = (ex, extra) => Object.assign({ depth: 0.2, gap: 0.6, thick: 0, shape: 'rect', params: P0, extras: ex || {} }, extra || {});
  // 用喷绘布配方测包边算量：铝塑板/亚克力/通用配方主干已含侧包，包边类会自动隐藏（见 BK 组）
  const rNone = E.tryDoorRecipe('门头 6米×2米 喷绘布', dcfg({}));
  const rEdge = E.tryDoorRecipe('门头 6米×2米 喷绘布', dcfg({ edge: true }));
  ck('M', '不勾选时清单不变', rEdge.hits.length === rNone.hits.length + 2, rEdge.hits.length + ' vs ' + rNone.hits.length);
  const edgeHits = rEdge.hits.filter((h) => h.extraKey === 'edge');
  ck('M', '包边=周长×侧包深(16×0.2=3.2㎡)', edgeHits.some((h) => h.type === 'lib' && Math.abs(h.q - 3.2) < 0.01), JSON.stringify(edgeHits.map((h) => [h.n, h.q])));
  ck('M', '包边带材料行', edgeHits.some((h) => h.type === 'mat' && h.q > 0));
  ck('M', '工艺项都带 extraKey', rEdge.hits.filter((h) => h.extraKey).length === 2 && !rNone.hits.some((h) => h.extraKey));
  const flat = E.tryDoorRecipe('门头 6米×2米 喷绘布', dcfg({ edge: true }, { depth: 0 }));
  ck('M', '贴墙(侧包0)仍按0.1米收边', flat.hits.some((h) => h.extraKey === 'edge' && h.type === 'lib' && Math.abs(h.q - 1.6) < 0.01), JSON.stringify(flat.hits.filter((h) => h.extraKey).map((h) => [h.n, h.q])));
  const hid = E.tryDoorRecipe('门头 6米×2米', dcfg({ edge: true }, { extraHidden: ['edge'] }));
  ck('M', '隐藏的工艺不出现', !hid.hits.some((h) => h.extraKey));
  const custDef = [{ key: 'ux_col', n: '立柱包柱', work: { id: 'i_seal', by: 'fixed', k: 2 }, mat: { n: '包柱板', u: '㎡', by: 'fixed', k: 1, p: 100 } }];
  const cust = E.tryDoorRecipe('门头 6米×2米', dcfg({ ux_col: true }, { extraDefs: custDef }));
  const uc = cust.hits.filter((h) => h.extraKey === 'ux_col');
  ck('M', '自定义工艺按套数生效', uc.length === 2 && uc.every((h) => Math.abs(h.q - (h.type === 'lib' ? 2 : 1)) < 0.01), JSON.stringify(uc.map((h) => [h.n, h.q])));
  ck('M', '内置工艺都有合法定额项', (E.DOOR_EXTRAS || []).every((x) => !x.work || !!E.getWorkItem(x.work.id)));
  const exMethods = [].concat(...(E.DOOR_EXTRAS || []).map((x) => [x.work && x.work.by, x.mat && x.mat.by])).filter(Boolean);
  ck('M', '计量方式都在白名单', exMethods.length > 0 && exMethods.every((v) => E.DOOR_EXTRA_METHODS.some((m) => m.v === v)), exMethods.join(','));
  // 金额：勾包边后人工/材料都应增加，且不是天价（包边材料 ≤ ¥600）
  const feeOf = (r) => E.calculate(r.hits.map((h) => h.type === 'mat' ? { kind: 'mat', n: h.n, u: h.u, q: h.q, p: h.p } : { id: h.id, q: h.q }),
    { params: Object.assign({}, P0, { minStart: 0 }), height: 'low', wall: 'flat' });
  const c0 = feeOf(rNone), c1 = feeOf(rEdge);
  const dLab = c1.labor - c0.labor, dMat = c1.matTotal - c0.matTotal;
  ck('M', '勾包边后人工增加', dLab > 40 && dLab < 600, Math.round(dLab));
  ck('M', '勾包边后材料增加', dMat > 200 && dMat < 600, Math.round(dMat));
  // UI 接线（历史教训：内核写好了却没接进界面，等于没做）
  ck('M', '拆解时把工艺勾选传给内核', appSrc.includes('extras: _estUI.doorExtras'));
  ck('M', '勾选即增量加/删（不重拆）', appSrc.includes('function estToggleDoorExtra(') && appSrc.includes('w.extraKey !== key'));
  ck('M', '配置页有工艺增项编辑器', appSrc.includes('id="estDoorExBox"') && appSrc.includes('data-ex-def'));
  ck('M', '工艺项独立成行便于精确移除', appSrc.includes('const exist = w.extraKey ? null :'));

  console.log('\n=== N. 门头工艺：脚手架按组 / 内置调价覆盖（2026-11-22） ===');
  // 门式脚手架：横排 ceil(宽/1.8)，竖排 ceil((高−1.8)/1.7)，最少各 1
  ck('N', '6×2m 门头 4 组', E.scaffoldSets(6, 2) === 4, E.scaffoldSets(6, 2));
  ck('N', '6×4m 门头 8 组（超高叠层）', E.scaffoldSets(6, 4) === 8, E.scaffoldSets(6, 4));
  ck('N', '8×6m 门头 15 组', E.scaffoldSets(8, 6) === 15, E.scaffoldSets(8, 6));
  ck('N', '3×2m 小门头 2 组', E.scaffoldSets(3, 2) === 2, E.scaffoldSets(3, 2));
  const rScaf = E.tryDoorRecipe('门头 6米×2米', dcfg({ scaffold: true }));
  const scafHits = rScaf.hits.filter((h) => h.extraKey === 'scaffold');
  ck('N', '脚手架按组出量（4 组）', scafHits.length === 1 && scafHits[0].type === 'lib' && Math.abs(scafHits[0].q - 4) < 0.01, JSON.stringify(scafHits.map((h) => [h.n, h.q])));
  ck('N', '脚手架单位是「组」不是㎡', scafHits[0] && scafHits[0].u === '组', scafHits[0] && scafHits[0].u);
  ck('N', '脚手架算量写明宽高组数', !!(scafHits[0] && /÷1\.8=4片/.test(scafHits[0].calc)), scafHits[0] && scafHits[0].calc);
  // 内置工艺「调价」：只覆盖材料单价，人工定额不能被丢掉
  const ov = [{ key: 'edge', n: '包边/封边', mat: { n: '包边铝塑板', u: '㎡', by: 'perimDepth', k: 1.3, p: 150 } }];
  const rOv = E.tryDoorRecipe('门头 6米×2米 喷绘布', dcfg({ edge: true }, { extraDefs: ov }));
  const ovHits = rOv.hits.filter((h) => h.extraKey === 'edge');
  ck('N', '覆盖单价后人工项仍在（深合并）', ovHits.some((h) => h.type === 'lib' && Math.abs(h.q - 3.2) < 0.01), JSON.stringify(ovHits.map((h) => [h.type, h.n, h.q])));
  ck('N', '覆盖后材料按新价新系数', ovHits.some((h) => h.type === 'mat' && h.p === 150 && Math.abs(h.q - 4.16) < 0.01), JSON.stringify(ovHits.filter((h) => h.type === 'mat').map((h) => [h.p, h.q])));
  const cOv = feeOf(rOv);
  ck('N', '覆盖单价后合价变高', cOv.matTotal > c1.matTotal, Math.round(cOv.matTotal) + ' vs ' + Math.round(c1.matTotal));
  // 材料系数填 0 = 不算材料（脚手架这类自有工具）
  const rNoMat = E.tryDoorRecipe('门头 6米×2米 喷绘布', dcfg({ edge: true }, { extraDefs: [{ key: 'edge', n: '包边/封边', mat: { n: '包边铝塑板', u: '㎡', by: 'perimDepth', k: 0, p: 150 } }] }));
  const nm = rNoMat.hits.filter((h) => h.extraKey === 'edge');
  ck('N', '材料系数 0 只出人工不出材料', nm.length === 1 && nm[0].type === 'lib', JSON.stringify(nm.map((h) => [h.type, h.q])));
  // UI：内置工艺可调价 + 可恢复默认 + 保存白名单带 scaffold
  ck('N', '内置行有「调价」入口', appSrc.includes('estExToggleOpen') && appSrc.includes('title="修改人工定额项 / 计量方式 / 系数 / 材料单价"'));
  ck('N', '调价写成同 key 覆盖内置', appSrc.includes('function estExEdit(') && appSrc.includes('function estExHasOverride('));
  ck('N', '能一键恢复内置默认价', appSrc.includes('function estExReset(') && appSrc.includes('恢复默认价'));
  ck('N', '保存时脚手架计量不被改回面积', /\["area", "perim", "perimDepth", "canopy", "scaffold", "fixed"\]/.test(appSrc));
  ck('N', '自定义列表排除内置覆盖项', appSrc.includes('function estExCustomList()') && appSrc.includes('custList.length'));

  console.log('\n=== O. 内置定额项直接编辑（覆盖，不再导出改 CSV，2026-11-22） ===');
  // 白名单：只留 n/u/tr/m/hf/wf，非法值丢弃，空对象不落地
  const ovCfg = gc.normalizeEstimateConfig({
    itemOverrides: {
      i_door: { n: ' 招牌整装 ', u: '㎡', tr: 'hg', m: '骨架→面板', hf: false, wf: true, h: 99, hack: 1 },
      i_led: { n: '', u: '', tr: 'bad', m: '' },
      i_x: 'oops',
      i_y: { n: '有效名' },
    },
  });
  const ov0 = ovCfg.itemOverrides || {};
  ck('O', '覆盖字段白名单保留 n/u/tr/m/hf/wf', ov0.i_door && ov0.i_door.n === '招牌整装' && ov0.i_door.tr === 'hg' && ov0.i_door.hf === false && ov0.i_door.wf === true, JSON.stringify(ov0.i_door));
  ck('O', '工时字段不入覆盖（仍走 WH 校准）', ov0.i_door && ov0.i_door.h === undefined, JSON.stringify(ov0.i_door));
  ck('O', '空/全非法的覆盖被丢弃', !ov0.i_led && !ov0.i_x, JSON.stringify(ov0));
  ck('O', '部分字段缺失也保留', ov0.i_y && ov0.i_y.n === '有效名', JSON.stringify(ov0.i_y));
  // 真实生效：覆盖后 WORK_ITEMS 与 WORK_GROUPS 都要跟着变（常用项/下拉/清单同源）
  const fakeWI = [{ id: 'i_door', n: '门头/招牌整体安装', u: '㎡', h: 2.4, hf: 1, wf: 1, tr: 'az', m: '骨架→面板' }];
  const fakeWG = [{ g: '① 门头', rows: [['i_door', '门头/招牌整体安装', '㎡', 2.4, 1, 1, 'az', '骨架→面板']] }];
  const wctx2 = vm.createContext({
    window: { Estimate: { WORK_ITEMS: fakeWI, WORK_GROUPS: fakeWG } },
    Estimate: { WORK_ITEMS: fakeWI, WORK_GROUPS: fakeWG },
    console, document: {},
    _estBuiltinItems: null, _estBuiltinGroups: null,
    estCfg: () => ({ customItems: [], hiddenItems: [], itemOverrides: { i_door: { n: '招牌整装', tr: 'hg' } } }),
  });
  vm.runInContext(slice('function estBuiltinItems(', '/* 智能拆解/批量文本也要认自定义项名称 */'), wctx2);
  wctx2.estSyncCustomItems();
  ck('O', '覆盖后内核项名称/工种生效', fakeWI[0].n === '招牌整装' && fakeWI[0].tr === 'hg', JSON.stringify([fakeWI[0].n, fakeWI[0].tr]));
  ck('O', '分组行名称同步（常用项/下拉显示改后名）', fakeWG[0].rows[0][1] === '招牌整装' && fakeWG[0].rows[0][6] === 'hg', JSON.stringify(fakeWG[0].rows[0]));
  // UI 接线：✎ 入口、面板、保存落库、导出带「已改内容」标记
  ck('O', '内置行有 ✎ 编辑入口', appSrc.includes('data-ov-btn=') && appSrc.includes('estItemOvToggle('));
  ck('O', '面板含名称/单位/工种/施工方式/高墙', appSrc.includes('function estItemOvPanelHtml(') && appSrc.includes('data-ov="tr"') && appSrc.includes('data-ov="hf"'));
  ck('O', '保存施工项时写入 itemOverrides', /async function estSaveItems\(\)[\s\S]{0,900}c\.itemOverrides\s*=/.test(appSrc));
  ck('O', '改回默认值自动删字段', appSrc.includes('function estItemOvSet(') && appSrc.includes('delete o[k]'));
  ck('O', '定额表导出标注「已改内容」', appSrc.includes('"已改内容"'));
  // 导入回填：名称/ID 命中内置项 → 覆盖，不新增重复自定义项
  ck('O', '导入时命中内置项按覆盖处理', appSrc.includes('覆盖内置项') && appSrc.includes('cc.itemOverrides = ovMerged'));
  ck('O', '定额表带 id 列便于改名后回填', /"备注", "id"\]/.test(appSrc));
  ck('O', '导入读 id / 施工方式列', appSrc.includes('estCsvCol(head, ["id", "标识"])') && appSrc.includes('estCsvCol(head, ["施工方式"])'));

  console.log('\n=== P. 灯箱布门头：内打光灯箱行业口径（2026-11-22） ===');
  // 灯箱布（3M/透光布）是内打光拉布灯箱：必须有底板（挡光/反光）+ 灯条 + 12V 电源，
  // 不能按「喷绘布直接绷方管」算。6×2=12㎡ → 灯条 @0.2m 行距 10 行 × 6m = 60 米。
  const PD = E.WORK_PARAM_DEFAULT;
  const lbCfg = { params: PD, extras: {}, extraDefs: [], extraHidden: [] };
  const lb = E.tryDoorRecipe('3M灯箱布门头 6×2米', lbCfg);
  ck('P', '灯箱布命中独立配方 lightbox', lb && lb.recipe.key === 'lightbox', lb && lb.recipe.key);
  ck('P', '尺寸「6×2米」按米算 =12㎡', Math.abs(lb.area - 12) < 1e-6, lb.area);
  const lbWork = lb.hits.filter((h) => h.type !== 'mat').map((h) => h.id);
  ck('P', '主干含底板/灯条/接线/布面',
    ['i_baseboard', 'i_lightbar', 'i_wire', 'i_lightcloth'].every((id) => lbWork.includes(id)), lbWork.join(','));
  const lbMat = lb.hits.filter((h) => h.type === 'mat').map((h) => h.n).join('|');
  ck('P', '材料含底板/灯条/电源/灯箱布',
    /灯箱底板/.test(lbMat) && /灯条/.test(lbMat) && /LED电源/.test(lbMat) && /灯箱布/.test(lbMat), lbMat);
  const bar = lb.hits.find((h) => h.id === 'i_lightbar');
  ck('P', '灯条按 0.2m 行距算 60 米', Math.abs(bar.q - 60) < 1e-6, bar && bar.q);
  const psu = lb.hits.find((h) => h.n === 'LED电源');
  ck('P', '12V 灯条 720W → 3 只电源', psu && psu.q === 3, psu && psu.q);
  const lb2 = E.tryDoorRecipe('3M灯箱布门头 6×2米', { ...lbCfg, params: { ...PD, lampGap: 0.3 } });
  ck('P', '灯条行距可调（0.3m → 42 米）', Math.round(lb2.hits.find((h) => h.id === 'i_lightbar').q) === 42,
    lb2.hits.find((h) => h.id === 'i_lightbar').q);
  // 不打光的喷绘布门头保持原样（v429：不污染高频正常路径）
  const sp = E.tryDoorRecipe('喷绘布门头 6×2米', lbCfg);
  ck('P', '喷绘布仍走 spray 不打光', sp.recipe.key === 'spray', sp.recipe.key);
  ck('P', '喷绘布不含底板/灯条/电源', !sp.hits.some((h) => /底板|灯条|LED电源/.test(h.n)), sp.hits.map((h) => h.n).join(','));
  ck('P', '喷绘布行数仍为 4', sp.hits.length === 4, sp.hits.length);
  const bi = E.getWorkItem('i_baseboard'), bl = E.getWorkItem('i_lightbar'), bc = E.getWorkItem('i_lightcloth');
  ck('P', '新增底板/灯条/布面三项定额', !!bi && !!bl && !!bc);
  ck('P', '灯条 0.10h/米 · 电工', bl && bl.h === 0.1 && bl.tr === 'dg', bl && [bl.h, bl.tr]);
  ck('P', '底板 0.55h/㎡ 快于面板 0.70', bi && bi.h < 0.7 && bi.tr === 'az', bi && bi.h);
  ck('P', 'lampGap 默认值 + 参数页入口（门头工艺区）',
    PD.lampGap === 0.2 && E.defaultConfig().door.lampGap === 0.2 && appSrc.includes('data-est-door="lampGap"'),
    JSON.stringify([PD.lampGap, E.defaultConfig().door.lampGap]));
  ck('P', '灯箱布下隐藏「底板补装」工艺（防重复计价）', /rk === "lightbox" \|\| rk === "coat"/.test(appSrc) && appSrc.includes('hidden.add("backplate")'));
  ck('P', '拆解结果提示已含底板/灯条/电源', appSrc.includes('含底板+灯条+12V电源'));

  console.log('\n=== Q. 第二批门头配方 + 识别缺陷修正（2026-11-22） ===');
  const qcfg = { params: PD, extras: {}, extraDefs: [], extraHidden: [] };
  const hitKey = (t) => { const r = E.tryDoorRecipe(t, qcfg); return r ? r.recipe.key : null; };
  // ① 四种新配方命中
  ck('Q', '铝方通门头 → lvf', hitKey('铝方通门头 6×2米') === 'lvf');
  ck('Q', '格栅门头 → lvf', hitKey('格栅门头 6×2米') === 'lvf');
  ck('Q', '石材门头 → stone', hitKey('石材门头 6×2米') === 'stone');
  ck('Q', '瓷砖/花岗岩 → stone', hitKey('瓷砖门头 6×2米') === 'stone' && hitKey('花岗岩干挂门头 6×2米') === 'stone');
  ck('Q', '真石漆/涂料 → coat（不被石材抢）', hitKey('真石漆门头 6×2米') === 'coat' && hitKey('涂料门头 6×2米') === 'coat');
  ck('Q', '镀锌板/彩钢板 → sheet', hitKey('镀锌板门头 6×2米') === 'sheet' && hitKey('彩钢板门头 6×2米') === 'sheet');
  ck('Q', '不锈钢板仍优先 ss（不落 sheet）', hitKey('不锈钢板门头 6×2米') === 'ss');
  // ② 关键词扩容
  ck('Q', '亚克力门头 → acr', hitKey('亚克力门头 6×2米') === 'acr');
  ck('Q', '卡布灯箱 → lightbox', hitKey('卡布灯箱门头 6×2米') === 'lightbox');
  ck('Q', '黑白板 → sheet', hitKey('黑白板门头 6×2米') === 'sheet');
  // ③ 铝方通计量：6×2 @0.12 = 50 根×2 米=100 米，间距可调
  const lvf = E.tryDoorRecipe('铝方通门头 6×2米', qcfg);
  const lvfIt = lvf.hits.find((h) => h.id === 'i_lvf');
  ck('Q', '铝方通 6×2 @0.12m 出量 100 米', lvfIt && Math.abs(lvfIt.q - 100) < 1e-6, lvfIt && lvfIt.q);
  const lvf2 = E.tryDoorRecipe('铝方通门头 6×2米', { ...qcfg, params: { ...PD, lvfGap: 0.2 } });
  ck('Q', '间距 0.2m → 60 米', Math.abs(lvf2.hits.find((h) => h.id === 'i_lvf').q - 60) < 1e-6,
    lvf2.hits.find((h) => h.id === 'i_lvf').q);
  ck('Q', 'lvfGap 默认 0.12 + 参数页入口', PD.lvfGap === 0.12 && E.defaultConfig().door.lvfGap === 0.12 && appSrc.includes('data-est-door="lvfGap"'));
  ck('Q', '新定额项 i_lvf/i_stone/i_coat 存在', !!E.getWorkItem('i_lvf') && !!E.getWorkItem('i_stone') && !!E.getWorkItem('i_coat'));
  ck('Q', '石材干挂工时高于贴板（0.9 > 0.7）', E.getWorkItem('i_stone').h > E.getWorkItem('i_fascia').h);
  // ④ 新配方只在提到发光字时才补字
  ck('Q', '石材门头默认不含发光字', !lvf.hits.concat([]).some((h) => h.id === 'i_led') && !E.tryDoorRecipe('石材门头 6×2米', qcfg).hits.some((h) => h.id === 'i_led'));
  const stGlow = E.tryDoorRecipe('石材门头 6×2米 发光字5个60厘米', qcfg);
  const stLed = stGlow.hits.find((h) => h.id === 'i_led');
  ck('Q', '写了发光字才补一行', !!stLed, stLed && stLed.q);
  ck('Q', '字面积按 5字×0.6² ≈1.8㎡', stLed && Math.abs(stLed.q - 1.8) < 0.01, stLed && stLed.q);
  // ⑤ 拆除不再按新建展开；招牌带尺寸才触发
  ck('Q', '门头拆除不展开配方', hitKey('门头拆除 6×2米') === null);
  ck('Q', '招牌拆除不展开配方', hitKey('招牌拆除 3个') === null);
  ck('Q', '「招牌 6×2米」也展开配方', hitKey('招牌 6×2米') === 'generic');
  ck('Q', '招牌不带尺寸不误触发', E.isDoorText('招牌制作 3个') === false);
  ck('Q', '拆除后新装仍按新装拆', hitKey('门头拆除后新装铝塑板门头 6×2米') === 'alc');
  // ⑥ parseSpec：拆除走拆除项、㎡ 不再当个数
  const spRemove = E.parseSpec('门头拆除 6×2米');
  ck('Q', '拆除 → i_remove 12㎡', spRemove.length === 1 && spRemove[0].id === 'i_remove' && spRemove[0].q === 12,
    JSON.stringify(spRemove.map((x) => [x.id, x.q])));
  const spLb = E.parseSpec('灯箱 12㎡');
  ck('Q', '灯箱 12㎡ 改按㎡（不接成 12 个）', spLb.length === 1 && spLb[0].id === 'i_lightbox' && spLb[0].q === 12,
    JSON.stringify(spLb.map((x) => [x.id, x.q, x.u])));
  ck('Q', '灯箱 2个 仍按个', E.parseSpec('灯箱 2个')[0].id === 'i_lb');
  // ⑦ 金额量级校验（6×2 门头，人工+材料+辅材）
  const moneyOf = (t) => {
    const r = E.tryDoorRecipe(t, qcfg); if (!r) return 0;
    let w = 0, m = 0;
    r.hits.forEach((h) => {
      if (h.type === 'mat') m += h.q * h.p;
      else { const it = E.getWorkItem(h.id); if (it) w += h.q * it.h * E.tradeRate(it, qcfg.params); }
    });
    return Math.round((w + m + m * 0.06) / r.area);
  };
  const pLvf = moneyOf('铝方通门头 6×2米'), pStone = moneyOf('石材门头 6×2米');
  const pCoat = moneyOf('真石漆门头 6×2米'), pSheet = moneyOf('镀锌板门头 6×2米');
  ck('Q', '铝方通 ≈300–450 元/㎡', pLvf > 300 && pLvf < 450, pLvf);
  ck('Q', '石材干挂 ≈450–650 元/㎡', pStone > 450 && pStone < 650, pStone);
  ck('Q', '真石漆 ≈220–380 元/㎡', pCoat > 220 && pCoat < 380, pCoat);
  ck('Q', '镀锌/彩钢 ≈180–300 元/㎡', pSheet > 180 && pSheet < 300, pSheet);
  ck('Q', '石材贵于镀锌板（材质差真实反映）', pStone > pSheet * 1.5, [pStone, pSheet]);
  ck('Q', 'UI 走内核 isDoorText（前后端同口径）', appSrc.includes('Estimate.isDoorText'));
  ck('Q', '拆解提示未含发光字时提醒补一句', appSrc.includes('未含发光字'));

  console.log('\n=== R. 自定义施工项（按工时）+ 本单设备天数（2026-11-22） ===');
  const rp = Object.assign({}, E.WORK_PARAM_DEFAULT);
  const hourItem = { cid: 'wkm_t1', mode: 'hours', custom: true, n: '特殊结构加固', u: '处', q: 3, h: 1.5, tr: 'hg' };
  const rh = E.resolveItem(hourItem, { params: rp, height: 'low', wall: 'flat' });
  ck('R', '按工时：量×工时=4.5h', Math.abs(rh.hours - 4.5) < 1e-9, rh.hours);
  ck('R', '按工时：焊工60元/时 → ¥270', Math.abs(rh.fee - 270) < 1e-9, rh.fee);
  ck('R', '按工时：note 写清口径', /3处 × 1.5工时 × 焊工60元\/时/.test(rh.note), rh.note);
  ck('R', '按工时：不叠高度/墙面系数（避免重复计价）',
    Math.abs(E.resolveItem(hourItem, { params: rp, height: 'high', wall: 'glass' }).fee - 270) < 1e-9);
  ck('R', '缺工种回退普工36元/时',
    Math.abs(E.resolveItem({ cid: 'wkm_t2', mode: 'hours', n: '搬运', u: '项', q: 1, h: 2 }, { params: rp }).fee - 72) < 1e-9);
  const rh0 = E.resolveItem({ cid: 'wkm_t3', mode: 'hours', n: 'x', u: '项', q: 0, h: 2, tr: 'pg' }, { params: rp });
  ck('R', '数量0不产生金额/工时', rh0.fee === 0 && rh0.hours === 0);
  ck('R', '自定义工时进总工时与人数建议', Math.abs(E.calculate([hourItem], { params: rp }).totalHours - 4.5) < 1e-9);
  const rQty = E.resolveItem({ cid: 'wkm_t4', mode: 'qty', custom: true, n: '包干小活', u: '项', q: 1, p: 500 }, { params: rp });
  ck('R', '切「按金额」：500元仍进施工费', rQty.fee === 500 && Math.abs(rQty.hours - 500 / 36) < 1e-6, [rQty.fee, rQty.hours]);
  // 设备天数：默认跟建议工期，ctx.equipDays 可覆盖
  const bigWork = [{ id: 'i_guide', q: 200 }];
  const auto = E.calculate(bigWork, { params: rp, height: 'mid' });
  ck('R', '默认设备天数跟建议工期（>1）', auto.equipDays > 1, auto.equipDays);
  const fixed = E.calculate(bigWork, { params: rp, height: 'mid', equipDays: 3 });
  ck('R', 'ctx.equipDays 覆盖为 3 天', fixed.equipDays === 3 && fixed.equip === rp.equipMid * 3, [fixed.equipDays, fixed.equip]);
  ck('R', 'equipDays=0 回到自动', E.calculate(bigWork, { params: rp, height: 'mid', equipDays: 0 }).equipDays === auto.equipDays);
  ck('R', '≤6米时设备费恒为 0（覆盖不误伤）', E.calculate(bigWork, { params: rp, height: 'low', equipDays: 3 }).equip === 0);
  const snapH = gc.buildCostEstimate([hourItem], E.calculate([hourItem], { params: rp }), { params: rp }, []);
  ck('R', '快照保留自定义项工时/工种', snapH.work[0].h === 1.5 && snapH.work[0].tr === 'hg' && snapH.work[0].mode === 'hours', JSON.stringify(snapH.work[0]));
  // UI 接线（防「内核有、界面没入口」）
  ck('R', '清单头部有「＋ 施工项」入口', appSrc.includes('estAddCustomWork()') && appSrc.includes('＋ 施工项'));
  // 施工条件布局（2026-11-22 三次优化）：收进底部折叠区，标题行本身就是摘要
  ck('R', '施工条件 chips 仍可选', appSrc.includes('id="estCond"') && appSrc.includes('est-cond-chip'));
  ck('R', '条件收在 details 内（不再横在清单上方）', /estAdvBody[\s\S]{0,160}id="estCond"/.test(appSrc), 'estCond 位置');
  ck('R', '折叠标题行有摘要位（estAdvSumTxt / estAdvSumEff）', appSrc.includes('id="estAdvSumTxt"') && appSrc.includes('id="estAdvSumEff"'));
  ck('R', '非标准条件标题行变黄', appSrc.includes('adv.classList.toggle("is-custom"'));
  ck('R', '标题行写出生效系数', appSrc.includes('eff.textContent = parts.join(" · ")'));
  // 自定义施工项一行（桌面）：金额进数量区，切换按钮折成 ⇄，不再占独立第三行
  ck('R', '按工时行金额内联（data-est-amt）', appSrc.includes('data-est-amt') && appSrc.includes('class="est-work-amt"'));
  ck('R', '按工时行不再渲染独立 calc 行', !appSrc.includes('est-work-calc-txt">${estHoursCalcHtml'));
  ck('R', '按金额计切换折成行内按钮', appSrc.includes('class="est-work-switch"'));
  ck('R', '改工时只刷金额不重绘（保输入焦点）', appSrc.includes('row.querySelector("[data-est-amt]")'));
  ck('R', '自定义项字段随 estAddWork 落清单', appSrc.includes('if (w.custom) item.custom = true;') && appSrc.includes('if (w.h != null) item.h'));
  ck('R', '改名命中定额自动带工时/工种', appSrc.includes('Estimate.WORK_ITEMS.find((x) => x.n === item.n)'));
  ck('R', '设备天数覆盖接进 calcCtx', appSrc.includes('equipDays: _estUI ? (Number(_estUI.equipDays) || 0) : 0'));

  console.log('\n=== S. 门头工艺增项：计量口径 + 异常高价护栏（2026-11-22） ===');
  const allEx = {}; E.DOOR_EXTRAS.forEach((x) => { allEx[x.key] = true; });
  const door6 = E.tryDoorRecipe('门头 6米×2米 喷绘布', { params: rp, extras: { drip: true, edge: true } });
  const dripHits = (door6.hits || []).filter((h) => h.extraKey === 'drip');
  const dripMat = dripHits.find((h) => h.type === 'mat') || {};
  ck('S', '檐口按「宽+两侧返边」6.4 米（不是整圈周长 16 米）', Math.abs(dripMat.q - 6.4) < 1e-9, dripMat.q);
  ck('S', '檐口材料单位改成「米」', dripMat.u === '米', dripMat.u);
  const door12 = E.tryDoorRecipe('门头 12米×2米', { params: rp, extras: { drip: true } });
  const drip12 = ((door12.hits || []).filter((h) => h.extraKey === 'drip').find((h) => h.type === 'mat') || {}).q;
  ck('S', '门头加宽时檐口只按宽增（12.4 米，不是 28 米）', Math.abs(drip12 - 12.4) < 1e-9, drip12);
  // 小面积不再把不足 1 个单位抬成 1（0.69㎡ 包边料按 1㎡ 收＝虚增）
  const doorSmall = E.tryDoorRecipe('门头 2米×1米 喷绘布', { params: rp, depth: 0, extras: { edge: true } });
  const edgeSmall = ((doorSmall.hits || []).filter((h) => h.extraKey === 'edge').find((h) => h.type === 'mat') || {}).q;
  ck('S', '小门头包边料按实算（0.69㎡，不再抬到 1㎡）', Math.abs(edgeSmall - 0.69) < 1e-9, edgeSmall);
  // 默认参数必须全部落在护栏内（不能一上来就报警）
  const benchChk = (t) => {
    const r = E.tryDoorRecipe(t, { params: rp, extras: allEx });
    const g = {};
    (r.hits || []).forEach((h) => {
      if (!h.extraKey) return;
      const o = g[h.extraKey] = g[h.extraKey] || { amt: 0, bench: null };
      if (h.type === 'mat') o.amt += h.q * (h.p || 0);
      else { const it = E.getWorkItem(h.id); o.amt += it ? h.q * it.h * E.tradeRate(it, rp) : 0; }
      if (h.bench) o.bench = h.bench;
    });
    return Object.keys(g).map((k) => ({ k, amt: g[k].amt, unit: g[k].bench && g[k].bench.qty > 0 ? g[k].amt / g[k].bench.qty : 0, hi: g[k].bench ? g[k].bench.hi : 0 }));
  };
  const stats6 = benchChk('门头 6米×2米 喷绘布');
  ck('S', '6×2 八项工艺折合都在行业上限内', stats6.length === 8 && stats6.every((x) => x.hi > 0 && x.unit <= x.hi * 1.001),
    JSON.stringify(stats6.map((x) => [x.k, Math.round(x.unit), x.hi])));
  // 参数填歪（材料单价 999）→ 折合必然超上限，UI 才能标红
  const doorBad = E.tryDoorRecipe('门头 6米×2米', { params: rp, extras: { drip: true }, extraDefs: [{ key: 'drip', mat: { p: 999 } }] });
  const badMat = (doorBad.hits || []).filter((h) => h.extraKey === 'drip').find((h) => h.type === 'mat') || {};
  const badAmt = badMat.q * badMat.p + 6.4 * 4.8;
  ck('S', '单价填歪时折合超上限（护栏能报出来）', badMat.p === 999 && badAmt / 6.4 > 75, [badMat.p, Math.round(badAmt / 6.4)]);
  ck('S', '每项都带 bench 对照量', stats6.every((x) => x.hi > 0));
  ck('S', '包边/不锈钢包边互斥（勾一个自动撤另一个）', appSrc.includes('const twin = key === "edge" ? "ssedge"') && appSrc.includes('已自动取消'));
  ck('S', '勾选区试算金额 + 超限告警接入', appSrc.includes('estExtraStat') && appSrc.includes('est-door-ex-warn'));
  ck('S', '结果面板显示工艺增项占比', appSrc.includes('其中工艺增项') && appSrc.includes('工艺增项已占主干'));

  console.log('\n=== T. 一句多物品 + 尺寸/米数归属（2026-11-22） ===');
  // 起因：用户输入「搭桁架 绷喷绘布 3.5*4米」只出喷绘布 14㎡，桁架整项丢失。
  // 根因①拆段要求每个空格词都命中词典，尺寸词不命中→整句一段；
  //      根因②匹配 break 在第一个命中（词典里「喷绘布」在「桁架」之前）。
  const tTruss = ids('搭桁架 绷喷绘布 3.5*4米');
  ck('T', '搭桁架+绷喷绘布 两项都识别', tTruss.length === 2 && tTruss.map((x) => x[0]).join() === 'i_truss,i_banner', JSON.stringify(tTruss));
  ck('T', '桁架按四边周长 15 米（3.5+4）×2', tTruss[0][1] === 15, JSON.stringify(tTruss[0]));
  ck('T', '喷绘布 14㎡', tTruss[1][1] === 14, JSON.stringify(tTruss[1]));
  ck('T', '不加空格也拆得出', ids('搭桁架绷喷绘布3.5*4米').length === 2);
  ck('T', '写了米数就按米（桁架 30米）', first('桁架 30米')[1] === 30, JSON.stringify(ids('桁架 30米')));
  ck('T', '米数与画面尺寸分开（20米 不覆盖 6*3米）', eq(ids('桁架搭建 20米 喷绘布 6*3米'), [['i_truss', 20], ['i_banner', 18]]), JSON.stringify(ids('桁架搭建 20米 喷绘布 6*3米')));
  ck('T', '尾部单位「3*4米」不再当 cm', first('喷绘布 3*4米')[1] === 12, JSON.stringify(ids('喷绘布 3*4米')));
  ck('T', '个位数长宽按米（3×2=6㎡）', first('钢架+喷绘布 3×2')[1] === 6, JSON.stringify(ids('钢架+喷绘布 3×2')));
  ck('T', '灯箱布仍先于灯箱（12㎡ 不被当 12 个）', eq(ids('灯箱布 12㎡'), [['i_lightcloth', 12]]), JSON.stringify(ids('灯箱布 12㎡')));
  ck('T', '数量词归属前一项（喷绘布 2张 桁架）', eq(ids('喷绘布 2张 桁架').map((x) => x[0]), ['i_banner', 'i_truss']), JSON.stringify(ids('喷绘布 2张 桁架')));
  ck('T', '管理词仍优先于内置同位置词（水牌架→水牌）', first('水牌架2个')[0] === 'i_easel', JSON.stringify(ids('水牌架2个')));
  ck('T', '喷绘布自动补画面材料规则仍在', appSrc.includes('i_banner:      { n: "喷绘布画面"'));
  // 画面类「物体+动作」紧贴（喷绘布换画面）算一件事，避免两条都按 14㎡ 计
  ck('T', '喷绘布换画面不双计', eq(ids('喷绘布换画面 3*4米'), [['i_banner', 12]]), JSON.stringify(ids('喷绘布换画面 3*4米')));
  // 桁架用量（2026-11-22）：数量不只是周长——框架 + 后斜撑，人工按框架、租赁按总长
  const tu = E.trussUsage(3.5, 5);
  ck('T', '桁架 3.5×5：框架 17 米', tu.frame === 17, JSON.stringify(tu));
  ck('T', '桁架 3.5×5：后斜撑 11.7 米（0.6×高 出挑，2 根）', tu.brace === 11.7, JSON.stringify(tu));
  ck('T', '桁架 3.5×5：总长 28.7 米 ≈ 10 节', tu.total === 28.7 && tu.sections === 10, JSON.stringify(tu));
  ck('T', '桁架 6×2：总长 20.7 米 ≈ 7 节', E.trussUsage(6, 2).total === 20.7 && E.trussUsage(6, 2).sections === 7, JSON.stringify(E.trussUsage(6, 2)));
  const tr5 = E.parseSpec('搭桁架 3.5*5米 绷喷绘布', {})[0];
  ck('T', '人工数量＝框架 17 米', tr5.q === 17, JSON.stringify(tr5));
  ck('T', '租赁数量＝总长 28.7 米（matQ）', tr5.matQ === 28.7, JSON.stringify(tr5));
  ck('T', 'calc 写清框架+斜撑+节数', /框架 17米 \+ 后斜撑 11\.7米 = 28\.7米 ≈ 10节/.test(String(tr5.calc)), String(tr5.calc));
  ck('T', '桁架进自动材料表（租赁按米）', appSrc.includes('i_truss:       { n: "桁架租赁"'));
  ck('T', '自动材料优先取 matQ', appSrc.includes('Number(h.matQ) > 0 ? Number(h.matQ) : Number(h.q)'));
  ck('T', '桁架提醒填运输里程', appSrc.includes('桁架/舞台要车拉'));
  ck('T', '单价库有桁架租赁（元/米）', JSON.stringify(E.CATALOG || []).includes('桁架租赁'));
  // 整体项与部件同现只留整体（否则一面墙收两遍）
  ck('T', '整体项去重：门头钢架只出门头', eq(ids('门头钢架 30㎡').map((x) => x[0]), ['i_door']), JSON.stringify(ids('门头钢架 30㎡')));
  ck('T', '整体项去重：软膜灯箱只出一项', ids('软膜灯箱 8㎡').length === 1, JSON.stringify(ids('软膜灯箱 8㎡')));

  // ===== U 组：按项反推工时 + 弹窗默认两栏宽窗（2026-11-22）=====
  ck('U', '快照结果行带定额 id（反推可对齐）', appSrc.includes('id: (r.it && r.it.id) || ""'));
  ck('U', '反推引擎存在', appSrc.includes('function estReverseSuggest()'));
  ck('U', '分摊口径＝实际 × 本项工时 ÷ 全项工时', /ratio = act \/ sum/.test(appSrc));
  ck('U', '跨项目取中位数（加权）', appSrc.includes('按工程量加权中位数'));
  ck('U', '样本门槛 2 单 / 偏差门槛 8%', appSrc.includes('EST_REV_MIN_SAMPLES = 2') && appSrc.includes('EST_REV_MIN_DEV = 0.08'));
  ck('U', '系数夹在 0.7–1.4', appSrc.includes('EST_REV_CLAMP = [0.7, 1.4]') && appSrc.includes('EST_REV_CLAMP[1]'));
  ck('U', '老快照对齐不上就跳过（不硬算）', /if \(!idOk && rows\.length !== works\.length\) \{ mismatch\+\+; return; \}/.test(appSrc));
  ck('U', '单项采纳写 WH', appSrc.includes('function estApplyReverseItem') && /c\.WH\[id\] = v;/.test(appSrc));
  ck('U', '全部采纳只存一次（防 429）', appSrc.includes('function estApplyReverseAll') && appSrc.includes('已采纳 ${list.length} 项定额工时'));
  ck('U', '施工项管理页有「反推工时」入口', appSrc.includes('onclick="estOpenAccuracy()"') && appSrc.includes('🎯 反推工时'));
  ck('U', '新建项目弹窗默认两栏宽窗（900）', /const defW = Math\.max\(560, Math\.min\(900, vw0 - 48\)\)/.test(appSrc));
  ck('U', '窗口可拖到 440 窄窗（可收窄）', /Math\.max\(440, Math\.min\(Number\(x\.w\) \|\| defW, vw - 24\)\)/.test(appSrc));
  ck('U', '几何记忆换 v2 key（旧 560 不覆盖新默认）', appSrc.includes('"project_form_win_geom_v2"'));
  ck('U', '双击标题栏复位到新默认宽', /g = clamp\(\{ left: Math\.round\(\(window\.innerWidth - defW\) \/ 2\)/.test(appSrc));

  // ---------- V. 施工明细汇总条：工时 + 金额 + 填入工程金额 ----------
  console.log('\n=== V. 施工明细汇总条（金额口径 / 一键填入）===');
  const vEl = (extra) => Object.assign({
    value: '', disabled: false, innerHTML: '', style: {}, offsetWidth: 1,
    classList: {
      _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); },
    },
  }, extra || {});
  const vEls = {}, vbox = { type: { value: '包工' }, toasts: [], deductions: [] };
  const vsb = {
    window: {},
    document: {
      getElementById: (id) => (vEls[id] === undefined ? null : vEls[id]),
      querySelector: (sel) => (String(sel).indexOf('contractType') >= 0 ? vbox.type : null),
    },
    console, setTimeout: () => {},
    safeJsonParse: (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } },
    costEstimateObject: (ce) => (typeof ce === 'string' ? vsb.safeJsonParse(ce, null) : ce),
    estCfg: () => ({ params: { rateNormal: 30 } }),
    toast: (m) => { vbox.toasts.push(m); },
    confirm: () => true,
    readCostDeductions: () => (vbox.deductions || []).map((d) => Object.assign({}, d)),
    renderCostDeductionEditor: (p, items) => { vbox.deductions = items; vbox.rendered = (vbox.rendered || 0) + 1; },
    onContractTypeChange: () => {},
    updateContractCalc: () => {},
  };
  vm.createContext(vsb);
  vm.runInContext([
    slice('function workItemsHours(items)', 'function workItemsHoursText(items)'),
    slice('function workItemsHoursText(items)', '/* 明细逐行 HTML'),
    slice('function wcState(scope)', 'function wcRender(scope)'),
    slice('function wcMoneyText(n)', 'function wcItemChange(scope, i, field, v)'),
  ].join('\n'), vsb);

  const CE = { grand: 2000, construction: 800, matTotal: 1200, labor: 600, totalHours: 5.9, items: [] };
  vsb.window._wcFormItems = [{ id: 'a', n: '桁架搭建', u: '米', q: 15.2, h: 5.9 }];
  vEls.pCostEstimate = vEl({ value: JSON.stringify(CE) });
  // 包工：工程金额只填施工费（人工+设备+运输），材料另算
  let pl = vsb.wcAmountPlan('wcForm');
  ck('V', '包工口径取 construction（不含材料）', pl.kind === 'est' && pl.amt === 800 && pl.label === '施工费' && pl.mat === 0, JSON.stringify(pl.amt));
  // 包工包料：填含料合计，并把材料费记成扣项
  vbox.type = { value: '包工包料' };
  pl = vsb.wcAmountPlan('wcForm');
  ck('V', '包工包料口径取 grand（含料）', pl.amt === 2000 && pl.label === '含料合计' && pl.mat === 1200, JSON.stringify([pl.amt, pl.mat]));
  // 无快照：退回工时 × 普通工单价
  vEls.pCostEstimate.value = '';
  vbox.type = { value: '包工' };
  pl = vsb.wcAmountPlan('wcForm');
  ck('V', '无快照 → 工时 × 普通工单价（人工参考）', pl.kind === 'hours' && pl.amt === 177 && pl.label === '人工参考', JSON.stringify(pl.amt));
  ck('V', '汇总条渲染工时/金额/填入按钮', (() => {
    const html = vsb.wcSummaryHtml('wcForm', { canFill: true });
    return html.indexOf('合计工时') >= 0 && html.indexOf('人工参考') >= 0 && html.indexOf('wcFillProjectAmount()') >= 0 && html.indexOf('填入工程金额') >= 0;
  })());
  ck('V', '无修改金额权限时不渲染填入按钮', vsb.wcSummaryHtml('wcForm', { canFill: false }).indexOf('wcFillProjectAmount()') < 0);
  // 快照工时与明细不一致 → 黄字提醒重算
  vEls.pCostEstimate.value = JSON.stringify(CE);
  vsb.window._wcFormItems = [{ id: 'a', n: '桁架搭建', u: '米', q: 15.2, h: 7.2 }];
  ck('V', '明细改过工时 → 标 is-stale 提醒重算', /class="wc-sum-tip is-stale"/.test(vsb.wcSummaryHtml('wcForm', { canFill: true })));
  vsb.window._wcFormItems = [{ id: 'a', n: '桁架搭建', u: '米', q: 15.2, h: 5.9 }];

  // 填入：包工包料同步写材料扣项；包工不写
  vEls.pProjectAmount = vEl({ value: '' });
  vEls.pfCostDeductions = vEl();
  vEls.pMaterialFeeRow = vEl({ style: { display: 'none' } });
  vbox.type = { value: '包工包料' };
  vbox.deductions = [];
  vsb.wcFillProjectAmount();
  ck('V', '包工包料填入工程金额 = 含料合计', Number(vEls.pProjectAmount.value) === 2000, String(vEls.pProjectAmount.value));
  ck('V', '包工包料同时记材料扣项（工费不被算高）',
    vbox.deductions.length === 1 && vbox.deductions[0].name === '材料费（测算）' && vbox.deductions[0].amount === 1200 && vbox.deductions[0].kind === 'material',
    JSON.stringify(vbox.deductions));
  ck('V', '材料扣项区自动展开（不再藏在隐藏行里）', vEls.pMaterialFeeRow.style.display === '');
  vbox.type = { value: '包工' };
  vbox.deductions = [];
  vEls.pProjectAmount.value = '';
  vsb.wcFillProjectAmount();
  ck('V', '包工只填施工费、不写材料扣项', Number(vEls.pProjectAmount.value) === 800 && vbox.deductions.length === 0, String(vEls.pProjectAmount.value));
  // 顺序坑：快照必须先落隐藏域，再重绘汇总条，否则先算成「人工参考」
  const estFormSlice = slice('function estFromProjectForm(kind)', '/* ---------- 导出报价单图片');
  ck('V', '测算回填先写快照再渲染汇总条',
    estFormSlice.indexOf('hidden.value = JSON.stringify(snapshot)') < estFormSlice.indexOf('wcRender("wcForm")'));
  ck('V', '明细编辑器只显示工时（不显示金额）',
    appSrc.indexOf('wcSummaryHtml("wcEdit", { canFill: false, money: false') >= 0);

  // A：测算快照必须写 matTotal，包工包料「填入工程金额」才能记材料扣项
  ck('V', 'A 快照写入 matTotal（内核 matTotal → cost_estimate）',
    /matTotal: result \? Math\.round\(\(Number\(result\.matTotal\)/.test(appSrc));
  ck('V', 'A wcAmountPlan 读 matTotal 决定材料扣项',
    /const matTotal = Number\(ce\.matTotal\) \|\| 0/.test(appSrc)
    && /plan\.isMat && plan\.mat > 0/.test(appSrc));

  // B：清单/明细合并口径统一（运行时验证）
  {
    const mergeParts = [
      'let _estUI = null;',
      slice('function costEstimateObject(ce)', '/* 单条明细字段归一化'),
      slice('function wcNormalizeItem(x, i)', '/* 落库/合计用'),
      slice('function normalizeWorkItems(raw)', 'function mergeEstimateRowsIntoItems('),
      slice('function mergeEstimateRowsIntoItems(', 'function workItemsHoursText('),
    ].join('\n');
    const mb = { console, Date, safeJsonParse: (s, d) => { try { return JSON.parse(s); } catch (_) { return d; } } };
    vm.createContext(mb); vm.runInContext(mergeParts, mb);
    // 同名「铝塑板」：材料行 + 施工行应各占一行，不被盖成一行
    const merged = vm.runInContext('mergeEstimateRowsIntoItems('
      + JSON.stringify([]) + ', '
      + JSON.stringify([
        { n: '铝塑板', u: '㎡', q: 10, hours: 0, isMat: true, note: '' },
        { n: '铝塑板', u: '㎡', q: 10, hours: 3, isMat: false, note: '' },
      ]) + ')', mb);
    ck('V', 'B 同名材料行与施工行不互相覆盖（行数一致）',
      merged.length === 2 && merged.some((x) => x.note === '材料') && merged.some((x) => x.h === 3),
      JSON.stringify(merged));
    // estAddWork 既有项材料判定与新增项同口径（isMat 也算材料）
    const addParts = slice('function estAddWork(w)', '/* 拆解结果中可补材料的画面/板材项');
    ck('V', 'B estAddWork 既有项 isMat 判定与新增同口径',
      addParts.includes('x.isMat || x.type === "mat" || x.kind === "mat"'));
  }

  // ---------- W. 配置持久化可诊断性（改了存不住 / 存哪了） ----------
  console.log('\n=== W. 测算配置持久化（云端 app_settings · 未保存保护）===');
  ck('W', '读取时带 updated_at 与 updated_by 记来源和保存人', appSrc.includes('select("value, updated_at, updated_by").eq("key", "estimate_config")'));
  ck('W', '保存失败按 RLS / 表缺失给人话', appSrc.includes('row-level security|permission denied')
    && appSrc.includes('app_settings 表不存在'));
  ck('W', '保存后回读校验（防止只写不读）', appSrc.includes('回读校验') && appSrc.includes('readBack'));
  ck('W', '参数页显示上次保存来源/时间/保存人', appSrc.includes('function estCfgSavedText') && appSrc.includes('est-cfg-saved')
    && appSrc.includes('保存人：${estCfgSavedBy(m.by)}') && appSrc.includes('早期版本未记录'));
  ck('W', '保存人 uid 换算姓名：人员缓存 → 当前登录人 → 短 id',
    appSrc.includes('function estCfgSavedBy(uid)') && appSrc.includes('x.id === uid')
    && appSrc.includes('currentProfile.id === uid') && appSrc.includes('currentUser.email')
    && appSrc.includes('String(uid).slice(0, 8)'));
  ck('W', '批量预取与保存回读都带 updated_by',
    appSrc.includes('.select("key,value,updated_at,updated_by")')
    && appSrc.includes('select("updated_at, updated_by").eq("key", "estimate_config")')
    && appSrc.includes('by = data.updated_by || by'));
  ck('W', '本机保存也标注当前登录人', appSrc.includes('本机保存（云端未读到 estimate_config') && appSrc.includes(' · 当前：${me}'));
  ck('W', '保存参数条 sticky 常显', appSrc.includes('est-cfg-save--sticky') && /\.est-cfg-save--sticky\s*\{[^}]*position:\s*sticky/.test(fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8')));
  ck('W', '未保存徽标 + 关闭抽屉二次确认', appSrc.includes('estCfgDirtyBadge') && appSrc.includes('参数/工艺有改动还没点「保存参数」'));
  ck('W', '切页签也拦未保存改动', appSrc.includes('切换页签会丢掉这些改动'));
  ck('W', '调价/勾选改动标脏（委托监听）', appSrc.includes('function estCfgDelegatedTouch')
    && appSrc.includes('d.addEventListener("input", estCfgDelegatedTouch)'));

  // ---------- X. 施工内容 → 施工明细（预约表单「按上方内容生成」） ----------
  // 起因 2026-11-22：用户粘贴编号清单「1桁架4.6x3m 5套 / 3 室内引导牌画面尺寸A3 3张 …」，
  // 生成的明细是「3」「室内引导牌画面尺寸A3」「3张」这类碎片——原来只按 [、,，\s] 切词，
  // 没走测算内核。现在改成按行/数量块切段，逐块交给 Estimate.parseSpec（与测算同源）。
  console.log('\n=== X. 施工内容 → 明细（按上方内容生成）===');
  const xbox = { toasts: [] };
  const xsb = {
    window: {},
    console, setTimeout: () => {},
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: () => null, querySelector: () => null },
    toast: (m) => { xbox.toasts.push(m); },
    confirm: () => true,
  };
  xsb.window.localStorage = xsb.localStorage;
  vm.createContext(xsb);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'estimate.js'), 'utf8'), xsb);
  vm.runInContext('Estimate = window.Estimate;', xsb); // 浏览器里 window.Estimate 即全局 Estimate
  const xEsc = appSrc.match(/function esc\(str\) \{[\s\S]*?\n\}/)[0];
  vm.runInContext([
    xEsc,
    slice('function workItemsHours(items)', 'function workItemsHoursText(items)'),
    slice('function wcNewItem()', 'function wcState(scope)'),
    slice('function wcStripOrdinal(s', 'window.wcForm = {'),
    slice('function estParseWithCustom(txt)', '/* 智能拆解模糊候选'),
  ].join('\n'), xsb);
  vm.runInContext('function estCfg(){ return { params: {}, WH: {}, customItems: [], synonyms: {} }; }', xsb);

  const list5 = ['1桁架4.6x3m 5套', '2室外指引牌80x120cm', '3 室内引导牌画面尺寸A3 3张',
    '4 胸牌证件8x12cm工作人员(20个)技术指导(10个)监督(5个)', '5 悬挂吊牌70x90cm 1条'].join('\n');
  const xr = xsb.wcItemsFromText(list5);
  const names = xr.rows.map((x) => x.n);
  ck('X', '编号列表：序号不单独成行', names.indexOf('3') < 0 && names.indexOf('5') < 0 && names.indexOf('4') < 0, JSON.stringify(names));
  ck('X', '编号列表：数量不单独成行（5套/3张）', !names.some((n) => /^\d+\s*(个|张|套|条|项)$/.test(n)), JSON.stringify(names));
  const truss = xr.rows.find((x) => x.n.indexOf('桁架') >= 0);
  ck('X', '桁架 4.6×3m 5套 → 76 米（框架×5套）', !!truss && truss.u === '米' && truss.q === 76, JSON.stringify(truss && [truss.q, truss.u]));
  ck('X', '桁架工时 = 0.3h/米 × 76', !!truss && truss.h === 22.8, JSON.stringify(truss && truss.h));
  const desk = xr.rows.find((x) => x.n.indexOf('胸牌') >= 0);
  ck('X', '一行多件：胸牌 20 个（尺寸不当新物品）', !!desk && desk.q === 20 && desk.u === '个', JSON.stringify(desk && [desk.q, desk.u]));
  ck('X', '一行多件：技术指导 10 / 监督 5 保留为自定义项',
    xr.rows.some((x) => x.n === '技术指导' && x.q === 10) && xr.rows.some((x) => x.n === '监督' && x.q === 5),
    JSON.stringify(xr.rows.map((x) => [x.n, x.q])));
  ck('X', '认不出的项工时留 0 并标注', xr.rows.filter((x) => x.h === 0).every((x) => x.note.indexOf('未匹配定额') >= 0));
  ck('X', '引导牌 3 张 → 3 个', (xr.rows.find((x) => x.n.indexOf('引导牌') >= 0) || {}).q === 3, JSON.stringify(names));

  const two = xsb.wcItemsFromText('搭桁架 绷喷绘布 3.5*4米').rows;
  ck('X', '一句两件各用定额名（不共用原文名）', two.length === 2 && two[0].n !== two[1].n, JSON.stringify(two.map((x) => x.n)));

  const door = xsb.wcItemsFromText('门头招牌 6*2米 发光字5个60厘米').rows;
  ck('X', '发光字“5个”是字数，不当门头套数（12㎡ 而非 60㎡）', door.length === 1 && door[0].q === 12, JSON.stringify(door.map((x) => [x.n, x.q])));

  const sets = xsb.wcItemsFromText('门头招牌 6*2米 发光字5个60厘米 2套').rows;
  ck('X', '纯数量块「2套」乘到上一件（12 → 24㎡）', sets.length === 1 && sets[0].q === 24, JSON.stringify(sets.map((x) => [x.n, x.q])));

  const rm = xsb.wcItemsFromText('门头拆除 6×2米').rows;
  ck('X', '纯拆除走拆除项', rm.length === 1 && rm[0].n.indexOf('拆除') >= 0, JSON.stringify(rm.map((x) => x.n)));

  ck('X', '生成走测算内核（不再按空格切词）', (() => {
    const i = appSrc.indexOf('function wcItemsFromText(');
    const seg = appSrc.slice(i, appSrc.indexOf('window.wcForm = {', i));
    const fillIdx = appSrc.indexOf('fill: () => {');
    const fillSeg = appSrc.slice(fillIdx, appSrc.indexOf('window.wcEdit = {', fillIdx));
    return seg.indexOf('estParseWithCustom(parseText)') >= 0 && fillSeg.indexOf('wcItemsFromText(raw)') >= 0
      && fillSeg.indexOf('[、,，\\s]') < 0;
  })());
  ck('X', '重新生成前二次确认（不静默覆盖已填明细）', appSrc.includes('现有 ${had} 行会被替换'));
  ck('X', '生成后提示未匹配项数', appSrc.includes('没匹配到定额，已按原文保留'));

  // ---------- Y. 施工明细增删（「＋ 添加明细」按钮 / 行下标对齐） ----------
  // 起因 2026-11-22：点「＋ 添加明细」毫无反应。真因是渲染层调 normalizeWorkItems，
  // 而它会过滤空名称行——刚 push 的空行在下一次 wcRender 就被滤掉；且过滤后 data-i
  // 与状态数组错位，改/删任意一行会打到相邻行。渲染层改为不过滤（wcNormalizeItem）。
  console.log('\n=== Y. 施工明细增删（添加明细 / 行下标对齐）===');
  const yEls = {};
  const ysb = {
    window: {}, console, setTimeout: () => {},
    localStorage: { getItem: () => null, setItem() {} },
    document: { getElementById: (id) => yEls[id] || null, querySelector: () => null },
    toast: () => {}, confirm: () => true,
  };
  ysb.window.localStorage = ysb.localStorage;
  vm.createContext(ysb);
  vm.runInContext([
    xEsc,
    slice('function wcNormalizeItem(x, i)', 'function normalizeWorkItems(raw)'),
    slice('function normalizeWorkItems(raw)', 'function getWorkItems(p)'),
    slice('function workItemsHtml(items', 'function wcNewItem()'),
    slice('function wcNewItem()', 'function wcState(scope)'),
    slice('function wcState(scope)', 'function wcRender(scope)'),
    slice('function wcRender(scope)', 'function wcUpdateTotal(scope)'),
    slice('function wcItemAdd(scope)', '/* 预约表单固定 chip'),
  ].join('\n'), ysb);
  vm.runInContext('function wcUpdateTotal() {}', ysb); // 汇总条不在本组范围，打桩

  const yItems = [{ id: 'a', n: '', u: '项', q: 1, h: 0 }, { id: 'b', n: '桁架', u: '米', q: 76, h: 22.8 }];
  const yHtml = ysb.workItemsHtml(yItems, 'wcForm', true);
  ck('Y', '空名称行也渲染（行数 = 状态长度）', (yHtml.match(/class="wc-item-row"/g) || []).length === 2,
    String((yHtml.match(/class="wc-item-row"/g) || []).length));
  ck('Y', 'data-i 与状态下标一一对应', yHtml.indexOf('data-i="0"') >= 0 && yHtml.indexOf('data-i="1"') >= 0);
  ck('Y', '落库仍过滤空名称行（不存空条目）', ysb.normalizeWorkItems(yItems).length === 1);

  yEls.pWorkItemsList = { innerHTML: '', querySelectorAll: () => [] };
  ysb.window._wcFormItems = [];
  ysb.wcItemAdd('wcForm');
  ck('Y', '点「＋ 添加明细」→ 状态 +1 且立即渲染出该行',
    ysb.window._wcFormItems.length === 1
    && (yEls.pWorkItemsList.innerHTML.match(/class="wc-item-row"/g) || []).length === 1,
    JSON.stringify([ysb.window._wcFormItems.length, yEls.pWorkItemsList.innerHTML.slice(0, 60)]));
  ck('Y', '明细区渲染不再走过滤版 normalizeWorkItems', (() => {
    const i = appSrc.indexOf('function workItemsHtml(items');
    const seg = appSrc.slice(i, appSrc.indexOf('function wcNewItem()', i));
    return seg.indexOf('map(wcNormalizeItem)') >= 0 && seg.indexOf('normalizeWorkItems(items)') < 0;
  })());

  // ---------- Z. 测算工具栏按钮层级（主 CTA / 幽灵入口） ----------
  // 起因 2026-11-22：四个同权小按钮挤在一行（outline 版实测需 426px，左栏只有 372px → 掉成 3+1 孤行）。
  // 现在主 CTA 实心渐变 + 三个浅底淡描边入口，桌面能排一行（窄屏走 3 列 grid，不会掉成孤行）。
  console.log('\n=== Z. 测算工具栏按钮（智能拆解主 CTA）===');
  const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const btnRow = (() => {
    const i = appSrc.indexOf('<div class="est-btnrow">');
    return appSrc.slice(i, appSrc.indexOf('</div>', appSrc.indexOf('estOpenHistory()', i)));
  })();
  ck('Z', '智能拆解用主 CTA 类（非普通 btn）', btnRow.includes('class="btn small est-parse-btn"') && btnRow.includes('est-parse-ico'));
  ck('Z', '三个次要入口用幽灵样式（无 emoji，不与 CTA 抢注意力）',
    (btnRow.match(/class="btn small ghost"/g) || []).length === 3 && !/[🧩🕒]/.test(btnRow));
  ck('Z', '原有四入口文案都在（智能拆解/方案库/常用施工项/历史）',
    ['智能拆解', '方案库', '常用施工项', '历史'].every((k) => btnRow.includes(k)));
  ck('Z', '主 CTA 有渐变 + 阴影 + 内高光', /\.est-btnrow \.est-parse-btn \{[\s\S]*?linear-gradient\(135deg[\s\S]*?box-shadow:[\s\S]*?inset 0 1px 0/.test(cssSrc));
  ck('Z', '主 CTA hover 有斜向扫光', cssSrc.includes('.est-btnrow .est-parse-btn:hover::after'));
  ck('Z', '幽灵入口浅底淡描边（看出是按钮）、hover 变靛蓝', /\.est-btnrow \.btn\.ghost \{[^}]*background: #f8fafc[^}]*border-color: #dbe3ee[^}]*color: #64748b/.test(cssSrc)
    && cssSrc.includes('.est-btnrow .btn.ghost:hover')
    && /\.est-list-ops \.btn\.ghost \{[^}]*border-color: #dbe3ee/.test(cssSrc));
  ck('Z', '窄屏主 CTA 占 2 格（不通栏）+ 三入口三列，历史不孤行',
    /@media \(max-width: 440px\) \{[\s\S]*?\.est-btnrow \{ display: grid; grid-template-columns: repeat\(3, minmax\(0, 1fr\)\)/.test(cssSrc)
    && /\.est-btnrow \.est-parse-btn \{ grid-column: span 2; \}/.test(cssSrc)
    && !/\.est-btnrow \.est-parse-btn \{ grid-column: 1 \/ -1; \}/.test(cssSrc));
  ck('Z', '历史按钮仍在按钮组内（随栅格自动落到第 2 行）',
    /onclick="estOpenHistory\(\)"[^>]*>历史</.test(appSrc));
  ck('Z', '尊重「减少动态效果」偏好', cssSrc.includes('@media (prefers-reduced-motion: reduce)') && cssSrc.includes('.est-parse-ico { animation: none; }'));
  ck('Z', 'toast 浅色卡片不刺眼（白底深字+左侧语义色条，非黑块）',
    /\.toast \{[^}]*color: #1e293b[^}]*background: #fff[^}]*border-left: 4px solid/.test(cssSrc)
    && /\.toast-info\s*\{ border-left-color:/.test(cssSrc) && !/\.toast-info\s*\{ background: #334155/.test(cssSrc));

  console.log('\n=== AA. 施工费测算使用说明（help.html）===');
  const helpSrc = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
  const estSec = (() => {
    const i = helpSrc.indexOf('<div class="section" id="estimate">');
    return helpSrc.slice(i, helpSrc.indexOf('<div class="section" id="review">', i));
  })();
  ck('AA', '有 #estimate 章节且目录里可跳转', estSec.length > 4000 && /<li><a href="#estimate">施工费测算<\/a><\/li>/.test(helpSrc));
  ck('AA', '说明书版本号已升到 v3.57', helpSrc.includes("使用说明书 v3.57"));
  ck('AA', '小节覆盖三步 / 明细 / 门头 / 填入 / 参数 / 反推 / 常见问题',
    ['三步出报价', '施工项清单的三种行', '门头：配方与工艺增项', '一键填入工程金额', '参数与单价（管理员）', '反推工时', '常见问题'].every((k) => estSec.includes(k)));
  ck('AA', '写明「测算不改金额链」与包工包料扣项', estSec.includes('测算不改金额链') && estSec.includes('材料费（测算）'));
  ck('AA', '窄屏表格固定布局 + 强制换行（防横向溢出）', /@media \(max-width: 600px\)[\s\S]*?#estimate table \{[^}]*table-layout: fixed/.test(helpSrc));
  ck('AA', 'help.html 进了发布清单与 SW 缓存（改文档会触发版本号）',
    fs.readFileSync(path.join(ROOT, 'release.js'), 'utf8').includes('"help.html"')
    && fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8').includes('./help.html'));
  ck('AA', 'showHelp 支持锚点 + iframe load 兜底定位',
    /function showHelp\(anchor\)/.test(appSrc) && appSrc.includes('fr.addEventListener("load", jump, { once: true })')
    && appSrc.includes('help.html#" + anchor'));
  ck('AA', '测算标题栏有「?」直达说明入口', /class="est-help-btn" onclick="showHelp\('estimate'\)"/.test(appSrc)
    && /\.est-help-btn \{/.test(cssSrc));

  // ---------- AB. 帮助页阅读导航 + 自定义施工项「存为定额项」 ----------
  // 起因 2026-11-22：说明书在 iframe 里一滚到底、回不去目录/系统；用户又问
  // 「自定义施工项是不是只能显示在自定义区，不能加进内置定额项」。
  console.log('\n=== AB. 帮助页导航 / 施工项存入定额库 ===');
  ck('AB', '说明书版本升到 v3.57（顶部与页脚一致）',
    helpSrc.includes("使用说明书 v3.57") && helpSrc.includes("文档版本：v3.57"));
  ck('AB', 'sticky 导航条：章节下拉 / 目录 / 上下节 / 顶部 / 返回系统',
    /\.help-nav \{[^}]*position: sticky/.test(helpSrc)
    && ['id="helpJump"', 'helpGoToc()', 'helpStep(-1)', 'helpStep(1)', 'helpGoTop()', 'helpBack()'].every((k) => helpSrc.includes(k)));
  ck('AB', '右下浮动回目录/回顶 + 章节末尾三连返回条',
    helpSrc.includes('id="helpFab"') && helpSrc.includes('help-back-toc')
    && helpSrc.includes('↑ 返回目录') && helpSrc.includes('✕ 返回系统'));
  ck('AB', 'hashchange 自定位（file:// 下父页面跨域兜底）',
    helpSrc.includes('addEventListener("hashchange", jumpToHash)') && helpSrc.includes('scroll-margin-top: 96px'));
  ck('AB', '窄屏导航下拉通栏、翻页按钮收起',
    /@media \(max-width: 600px\)[\s\S]*?\.help-nav-jump \{ flex: 1 1 100%/.test(helpSrc)
    && helpSrc.includes('.help-nav-btn--step { display: none; }'));
  ck('AB', '清单行有「存」按钮且只给 custom+hours 行',
    appSrc.includes('class="est-work-lib"') && appSrc.includes('onclick="estWorkSaveAsLib(${i})"')
    && /const libBtn = \(w\.custom && isHours\)/.test(appSrc));
  ck('AB', '两池关系写进配置管理页（内置不可新增）',
    appSrc.includes('est-item-pools-hint') && appSrc.includes('不能新增'));
  ck('AB', '存库三道护栏：默认名 / 权限 / 内置项',
    ['n === "自定义施工项"', '!estCanManage()', '!x._ggCustom'].every((k) => appSrc.includes(k)));
  ck('AB', '操作区包一层、窄屏 grid-area 指到 ops',
    cssSrc.includes('.est-work-ops {') && cssSrc.includes('.est-work-lib {')
    && cssSrc.includes('.est-work-row.is-hours .est-work-ops { grid-area: 1 / 2; }')
    && cssSrc.includes('grid-template-columns: minmax(0,1fr) auto auto;'));
  const libSlice = slice('async function estWorkSaveAsLib(i)', 'function estClearWork()');
  let libCfg = { customItems: [] }, libOk = true, libRender = 0, libToasts = [];
  const libsb = {
    window: { Estimate: { WORK_ITEMS: [{ id: 'i_door', n: '门头/招牌整体安装' }], TRADES: { pg: { n: '普工' }, az: { n: '安装技工' } } } },
    _estUI: { work: [{ custom: true, mode: 'hours', n: '安装不锈钢字', u: '个', h: 1.5, tr: 'az', calc: '焊接固定' }] },
    estCanManage: () => true, estCfg: () => libCfg,
    saveEstimateConfig: async () => libOk, renderEstimateWorkList: () => { libRender++; },
    toast: (m) => { libToasts.push(m); }, confirm: () => true, console,
  };
  libsb.Estimate = libsb.window.Estimate;
  vm.createContext(libsb);
  vm.runInContext(libSlice, libsb);
  await libsb.estWorkSaveAsLib(0);
  ck('AB', '运行时：自定义项写进 customItems 并调云端保存',
    libCfg.customItems.length === 1 && libCfg.customItems[0].n === '安装不锈钢字'
    && libCfg.customItems[0].h === 1.5 && libCfg.customItems[0].tr === 'az' && libRender === 1);
  libCfg = { customItems: [{ id: 'uc_keep', n: '安装不锈钢字', u: '项', h: 9, tr: 'pg' }] };
  libOk = true; libRender = 0;
  await libsb.estWorkSaveAsLib(0);
  ck('AB', '运行时：同名覆盖保留原 id、不新增重复项',
    libCfg.customItems.length === 1 && libCfg.customItems[0].id === 'uc_keep' && libCfg.customItems[0].h === 1.5);
  libCfg = { customItems: [] }; libOk = false; libRender = 0;
  await libsb.estWorkSaveAsLib(0);
  ck('AB', '运行时：云端保存失败不重绘清单', libRender === 0);

  // ---------- AC. 单价库同名行覆盖门头配方材料价 ----------
  // 起因 2026-11-23：用户问单价库「门头板材 650/㎡」既然不参与测算、存在的意义是什么——
  // 接通机制：单价库建与配方材料完全同名的行 → 覆盖配方预置价（只认精确同名，防整门口径误伤）。
  console.log('\n=== AC. 单价库覆盖配方材料价 ===');
  ck('AC', '内核：配方材料行支持 catP 精确同名覆盖',
    estSrc.includes('cfg.catP') && estSrc.includes("x.calc += ' · 单价库'"));
  ck('AC', 'app：三处 tryDoorRecipe 调用都传 catP',
    (appSrc.match(/catP: estCatPriceMap\(\)/g) || []).length === 3 && appSrc.includes('function estCatPriceMap()'));
  const m1 = xsb.Estimate.tryDoorRecipe('门头 6米×2米 灯箱布', { catP: { '灯箱布（3M/透光布）': 50 } });
  const cloth1 = (m1.hits || []).find((h) => h.type === 'mat' && h.n === '灯箱布（3M/透光布）');
  ck('AC', '运行时：同名行覆盖配方价 35→50 并标注来源',
    !!cloth1 && cloth1.p === 50 && /单价库/.test(cloth1.calc), JSON.stringify(cloth1 && [cloth1.p, cloth1.calc]));
  const m2 = xsb.Estimate.tryDoorRecipe('门头 6米×2米 灯箱布', {});
  const cloth2 = (m2.hits || []).find((h) => h.type === 'mat' && h.n === '灯箱布（3M/透光布）');
  ck('AC', '运行时：无 catP 时维持配方预置价 35', !!cloth2 && cloth2.p === 35, JSON.stringify(cloth2 && cloth2.p));
  const m3 = xsb.Estimate.tryDoorRecipe('门头 6米×2米 铝塑板', { catP: { '铝塑板门头': 650 } });
  const alu = (m3.hits || []).find((h) => h.type === 'mat' && h.n === '铝塑板');
  ck('AC', '运行时：整门口径「铝塑板门头 650」不误伤材料行「铝塑板 95」', !!alu && alu.p === 95, JSON.stringify(alu && alu.p));

  // ---------- AD. 三方价目一致性（配方/工艺材料 × 单价库 × 参数） ----------
  // 起因 2026-11-23：用户问「单价库哪些价真参与测算」——对账发现配方材料名大多在单价库无同名行，
  // 且喷绘布配方 22 vs 自动补料 12 打架、方管 20/24 两种价、LED电源/电线/结构胶 近名不同名。
  // 修正后立此存照：配方/工艺每种材料必须在单价库有同名行且默认价相等（改配方忘改库直接报红）。
  console.log('\n=== AD. 三方价目一致性 ===');
  const catMap = {}, catPrice = {};
  xsb.Estimate.CATALOG.forEach((g) => (g.rows || []).forEach((r) => {
    if (Number(r[2]) > 0) { catMap[r[1]] = Number(r[2]); catPrice[r[1]] = r; }
  }));
  const mats = [];
  Object.values(xsb.Estimate.DOOR_RECIPES).forEach((rc) => (rc.mat || []).forEach((x) => mats.push(x)));
  xsb.Estimate.DOOR_EXTRAS.forEach((ex) => { if (ex.mat) mats.push(ex.mat); });
  const noName = mats.filter((x) => !(x.n in catPrice));
  ck('AD', '配方/工艺每种材料在单价库都有同名行（含⑪组）', noName.length === 0, JSON.stringify(noName.map((x) => x.n)));
  const priceDiff = mats.filter((x) => Number(catPrice[x.n] && catPrice[x.n][2]) !== Number(x.p));
  ck('AD', '单价库默认价 = 配方预置价（默认测算零变化）',
    priceDiff.length === 0, JSON.stringify(priceDiff.map((x) => [x.n, x.p, catPrice[x.n] && catPrice[x.n][2]])));
  const autoSrc = appSrc.match(/const EST_AUTO_MAT = \{[\s\S]*?\n\};/)[0];
  const AUTO = new Function(autoSrc + '; return EST_AUTO_MAT;')();
  const autoMiss = Object.values(AUTO).flatMap((m) => (Array.isArray(m) ? m : [m]))
    .filter((m) => m && m.cat && !(m.cat in catPrice));
  ck('AD', '自动补材料（EST_AUTO_MAT）的类目名都能在单价库取到价', autoMiss.length === 0, JSON.stringify(autoMiss.map((m) => m.cat)));
  const spm = (xsb.Estimate.DOOR_RECIPES.spray.mat || []).find((x) => String(x.n).indexOf('喷绘') >= 0);
  ck('AD', '喷绘布口径统一：配方行=「喷绘布画面」12/㎡（原配方 22 与自动补料 12 打架）',
    !!spm && spm.n === '喷绘布画面' && spm.p === 12, JSON.stringify(spm));
  const steelPrices = [...new Set(Object.values(xsb.Estimate.DOOR_RECIPES).flatMap((rc) => (rc.mat || []).filter((x) => String(x.n).indexOf('方管') >= 0).map((x) => x.p)))];
  ck('AD', '骨架方管价统一 20/米（原 acr/stone 24 与其余 20 打架）',
    steelPrices.length === 1 && steelPrices[0] === 20, JSON.stringify(steelPrices));
  // 运行时终验：整包单价库接管 catP 后，10 种配方每个材料价一分不变
  const recipeTxt = { alc: '铝塑板', ss: '不锈钢', acr: '亚克力面板', pvc: 'PVC', lightbox: '灯箱布', spray: '喷绘布画面', lvf: '铝方通', stone: '石材干挂', coat: '真石漆', sheet: '镀锌板' };
  const diffAll = [];
  Object.entries(recipeTxt).forEach(([k, w]) => {
    const a = xsb.Estimate.tryDoorRecipe('门头 6米×2米 ' + w, {});
    const b = xsb.Estimate.tryDoorRecipe('门头 6米×2米 ' + w, { catP: catMap });
    const pm = (r) => new Map(((r && r.hits) || []).filter((h) => h.type === 'mat').map((h) => [h.n, h.p]));
    pm(a).forEach((p, n) => { if (pm(b).get(n) !== p) diffAll.push([k, n, p, pm(b).get(n)]); });
  });
  ck('AD', '运行时：默认单价库接管 catP 后 10 种配方材料价一分不变', diffAll.length === 0, JSON.stringify(diffAll));
  ck('AD', '老快照 v:3 迁移：e_power/e_wire/a_glue 改名对齐 + 补⑪组',
    appSrc.includes('if (ver < 3 && row.id === "e_power")') && appSrc.includes('⑪ 门头配方材料')
      && (appSrc.match(/v: 7,/) || []).length === 1);

  // ---------- AE. 未识别词全员云端上报（本机 + 云端合并，管理端绑定） ----------
  // 起因 2026-11-23：用户问「所有人使用时未识别词能否收集起来」——原来只存本机 localStorage，
  // 换台手机就丢、别人踩的坑看不见。现加 estimate_unknown_words 表（全员 insert/update，
  // estimate_manage 可删），上报静默失败不阻塞拆解，管理端合并查看/绑定/删除。
  console.log('\n=== AE. 未识别词云端上报 ===');
  ck('AE', '上报函数 + 合并视图存在', appSrc.includes('estUnknownCloudLog') && appSrc.includes('estUnknownMerged')
    && appSrc.includes('estimate_unknown_words'));
  ck('AE', '两个 SQL 文件都建表且删除权限 estimate_manage',
    ['supabase_rbac_migration.sql', 'supabase_schema.sql'].every((f) => {
      const s = fs.readFileSync(path.join(ROOT, f), 'utf8');
      return s.includes('create table if not exists public.estimate_unknown_words')
        && s.includes('est_unknown_delete') && s.includes("my_can('estimate_manage')");
    }));
  ck('AE', '上报已是同义词的词跳过（绑定后不再上报）',
    /estUnknownCloudLog[\s\S]*?synonyms[\s\S]*?\[t\]\) return/.test(appSrc));
  ck('AE', '「转方案」入口 + 模板落云后自动移除来源记录',
    appSrc.includes('estUnknownToCombo') && appSrc.includes('>转方案</button>')
    && /estSaveComboManage[\s\S]*?_estUnkComboSrc[\s\S]*?estUnknownRemove/.test(appSrc)
    && appSrc.includes('_estUnkComboSrc = null; estRenderComboManage()'));
  ck('AE', '转方案小按钮在词所在 meta 行、绑定行只留三列',
    /<div class="est-unk-meta">[\s\S]{0,400}?estUnknownToCombo\(\$\{i\}\)[\s\S]{0,260}?<\/div>\s*(?:\$\{_estAiSuggest\[i\][\s\S]{0,300}?\})?\s*<div class="est-unk-bind">/.test(appSrc)
    && /\.est-unk-bind, \.est-syn-add \{[^}]*grid-template-columns: minmax\(0,1\.1fr\) minmax\(0,1\.4fr\) auto;/.test(cssSrc));

  // 运行时：假 sb 验证 insert / update / 合并 / 绑定全链路
  const unkCalls = [];
  const unkRow = { existing: null }; // maybeSingle 返回值
  const usBq = (table) => {
    const q = {
      table, op: null, payload: null, filters: [],
      select() { this.op = 'select'; return this; },
      update(p) { this.op = 'update'; this.payload = p; return this; },
      insert(p) { this.op = 'insert'; this.payload = p; return this; },
      delete() { this.op = 'delete'; return this; },
      eq(k, v) { this.filters.push([k, v]); return this; },
      neq(k, v) { this.filters.push([k, v]); return this; },
      order() { return this; }, limit() { return this; },
      maybeSingle() { unkCalls.push(['select', this.filters]); return Promise.resolve({ data: unkRow.existing, error: null }); },
      then(res, rej) { unkCalls.push([this.op, this.payload, this.filters]); return Promise.resolve({ data: null, error: null }).then(res, rej); },
    };
    return q;
  };
  const unkStore = {};
  const ucfg = { synonyms: {} }; // estCfg 必须返回稳定单例（真实代码里写入 estCfg().synonyms 靠引用生效）
  const usB = {
    window: {}, console, MODE: 'cloud',
    setTimeout, clearTimeout,
    localStorage: { getItem: (k) => unkStore[k] || null, setItem: (k, v) => { unkStore[k] = v; }, removeItem: (k) => { delete unkStore[k]; } },
    document: { getElementById: (id) => (id === 'estUkW0' ? { value: '指引牌' } : id === 'estUnS0' ? { value: 'i_guide' } : null) },
    sb: { from: usBq },
    estCfg: () => ucfg,
    saveEstimateConfig: () => Promise.resolve(true),
    safeJsonParse: (s, d) => { try { return s == null ? d : JSON.parse(s); } catch (_) { return d; } },
    estCanManage: () => true, estShowDrawer: () => {}, estOpenUnknownDrawer: () => {},
    esc: (s) => String(s == null ? "" : s),
    estItemOptionsHtml: () => '', estSynItemName: (id) => id,
    estComboNew: () => { usB.__comboNew = (usB.__comboNew || 0) + 1; },
    toast: () => {}, confirm: () => true, copyText: () => {},
  };
  usB.window.localStorage = usB.localStorage;
  vm.createContext(usB);
  vm.runInContext([
    slice('const EST_UNKNOWN_KEY', 'function estItemOptionsHtml'),
    slice('async function estOpenUnknownDrawer', 'async function estSynAdd'),
  ].join('\n'), usB);

  await usB.estUnknownLog('新款指引牌制作', false);
  await new Promise((r) => setTimeout(r, 0));
  ck('AE', '运行时：未识别输入上报 insert（云端 1 行）',
    unkCalls.some((c) => c[0] === 'insert' && c[1] && c[1].word === '新款指引牌制作'), JSON.stringify(unkCalls[0]));

  ucfg.synonyms['已是同义词的词'] = 'i_led'; // 先造成"已绑定"状态
  usB.estUnknownLog('已是同义词的词', false);
  await new Promise((r) => setTimeout(r, 0));
  ck('AE', '运行时：已是同义词的词不再上报',
    !unkCalls.some((c) => (c[0] === 'insert' || c[0] === 'update') && c[1] && c[1].word === '已是同义词的词'));

  unkRow.existing = { n: 4 };
  usB.estUnknownLog('新款指引牌制作', false);
  await new Promise((r) => setTimeout(r, 0));
  const upd = unkCalls.find((c) => c[0] === 'update' && c[1] && c[1].n === 5);
  ck('AE', '运行时：重复输入云端计数 +1（4→5）', !!upd, JSON.stringify(upd));

  // _estUnkCloud 是 vm 上下文里的 let 词法绑定，必须用 runInContext 赋值（usB.window 上写无效）
  vm.runInContext("_estUnkCloud = [{ word: '云端才有的词', n: 3, c: false, updated_at: '2026-11-23T01:00:00Z' }]", usB);
  const mg = usB.estUnknownMerged();
  const cl = mg.find((x) => x.t === '云端才有的词');
  ck('AE', '运行时：合并视图收进云端行并标 cloud', !!cl && cl.n === 3 && cl.cloud === true, JSON.stringify(cl));

  // 让「新款指引牌制作」排到合并列表第 0 位（云端时间戳最大），绑定走真实下标
  vm.runInContext("_estUnkCloud = [{ word: '新款指引牌制作', n: 7, c: false, updated_at: '9999-12-31T00:00:00Z' }]", usB);
  await usB.estUnknownBind(0);
  ck('AE', '运行时：绑定写同义词 + 删云端行 + 本机移除',
    ucfg.synonyms['指引牌'] === 'i_guide'
    && unkCalls.some((c) => c[0] === 'delete' && c[2] && c[2].some((f) => f[0] === 'word' && f[1] === '新款指引牌制作'))
    && !(usB.estUnknownLoad() || []).some((x) => x.t === '新款指引牌制作'),
    JSON.stringify([ucfg.synonyms, unkCalls[unkCalls.length - 1]]));

  // 转方案：多物品整句 → 模板编辑器预填名 + 标记来源
  vm.runInContext("_estUnkCloud = [{ word: '转方案测试词', n: 2, c: false, updated_at: '9999-12-31T00:00:00Z' }]", usB);
  usB.estUnknownToCombo(0);
  ck('AE', '运行时：转方案进模板编辑器 + 来源标记指向该条',
    usB.__comboNew === 1 && vm.runInContext('_estUnkComboSrc', usB) === '转方案测试词',
    JSON.stringify([usB.__comboNew, vm.runInContext('_estUnkComboSrc', usB)]));
  vm.runInContext('_estUnkComboSrc = null', usB); // 不影响后续断言

  // AF. 项目表单「施工内容 / 注意事项」按内容自适应高度
  ck('AF', '两个多行框挂自动增高，打开表单与程序回填都触发',
    /id="pWorkContentCustom"[^>]*oninput="ggAutoGrowTextarea\(this,72,260\)"/.test(appSrc)
    && /id="pNote"[^>]*oninput="ggAutoGrowTextarea\(this,72,240\)"/.test(appSrc)
    && (appSrc.match(/ggAutoGrowProjectTextareas\(\)/g) || []).length >= 2
    && (appSrc.match(/ggAutoGrowTextarea\(customEl, 72, 260\)/g) || []).length >= 2);
  const growSb = { console };
  vm.createContext(growSb);
  vm.runInContext(slice('function ggAutoGrowTextarea', 'function projectForm'), growSb);
  const mkTa = (h) => ({ style: {}, scrollHeight: h });
  const ta1 = mkTa(30); growSb.ggAutoGrowTextarea(ta1, 72, 260);
  ck('AF', '运行时：内容少给最小高度（不出现滚动条）',
    ta1.style.height === '72px' && ta1.style.overflowY === 'hidden', JSON.stringify(ta1.style));
  const ta2 = mkTa(150); growSb.ggAutoGrowTextarea(ta2, 72, 260);
  ck('AF', '运行时：内容多按内容长高（含 2px 边框补偿）',
    ta2.style.height === '152px' && ta2.style.overflowY === 'hidden', JSON.stringify(ta2.style));
  const ta3 = mkTa(900); growSb.ggAutoGrowTextarea(ta3, 72, 260);
  ck('AF', '运行时：超过上限停在上限并出滚动条',
    ta3.style.height === '260px' && ta3.style.overflowY === 'auto', JSON.stringify(ta3.style));

  // AG. 呆料提示（只显示不改金额）
  ck('AG', '内核传递净用量/定尺字段，app 侧只转存不进金额',
    /netQty: x\.netQty, bars: x\.bars, barLeft: x\.barLeft/.test(estSrc)
    && /if \(w\.netQty > 0\) item\.netQty = w\.netQty/.test(appSrc)
    && /fee: q \* price/.test(estSrc));
  const dg = xsb.Estimate.tryDoorRecipe('门头 6米×2米 铝塑板', {});
  const dgAlu = (dg.hits || []).find((h) => h.type === 'mat' && h.n === '铝塑板');
  const dgTube = (dg.hits || []).find((h) => h.type === 'mat' && h.n === '热镀锌方管(骨架)');
  ck('AG', '板材行带净用量（整张取整前）与整张数',
    !!dgAlu && dgAlu.sheets > 0 && dgAlu.netQty > 0 && dgAlu.q > dgAlu.netQty && Math.abs(dgAlu.q - dgAlu.sheets * 2.98) < 0.02,
    JSON.stringify(dgAlu && [dgAlu.q, dgAlu.netQty, dgAlu.sheets]));
  ck('AG', '方管行带 6 米定尺根数/切余米数',
    !!dgTube && dgTube.bars > 0 && dgTube.barLeft >= 0 && dgTube.barLeft < 6
    && dgTube.bars === Math.ceil(dgTube.q / 6),
    JSON.stringify(dgTube && [dgTube.q, dgTube.bars, dgTube.barLeft]));
  const dgNote = xsb.Estimate.resolveItem({ kind: 'mat', n: '铝塑板', u: '㎡', q: dgAlu.q, p: 95, sheets: dgAlu.sheets, netQty: dgAlu.netQty }, { params: {} });
  ck('AG', '板材结果行标净用/呆料但金额仍=整张面积×单价',
    /呆料/.test(dgNote.note) && Math.abs(dgNote.fee - dgAlu.q * 95) < 0.001 && dgNote.hours === 0,
    JSON.stringify([dgNote.note, dgNote.fee]));
  const dgTubeNote = xsb.Estimate.resolveItem({ kind: 'mat', n: '方管', u: '米', q: dgTube.q, p: 20, bars: dgTube.bars, barLeft: dgTube.barLeft }, { params: {} });
  ck('AG', '方管结果行标定尺根数/余料但金额仍=净米数×单价',
    /6米\/根/.test(dgTubeNote.note) && /余/.test(dgTubeNote.note) && Math.abs(dgTubeNote.fee - dgTube.q * 20) < 0.001,
    JSON.stringify([dgTubeNote.note, dgTubeNote.fee]));
  const dgPlain = xsb.Estimate.resolveItem({ kind: 'mat', n: '喷绘布画面', u: '㎡', q: 12, p: 12 }, { params: {} });
  ck('AG', '无净用量/定尺的普通材料行文字不变（不污染）',
    !/呆料|米\/根/.test(dgPlain.note), dgPlain.note);

  // AH. 高门头板材按实尺排版（2026-11-23）：h>2.44m 一张板不够高，面积法会少算张数与金额
  ck('AH', '排板函数 + 主配方/工艺背板/结果行三处接线',
    /function sheetLayoutCount\(w, h\)/.test(estSrc)
    && /const lay = sheetLayoutCount\(w, h\)/.test(estSrc)
    && /const lay = sheetLayoutCount\(d\.w, d\.h\)/.test(estSrc)
    && /m\.by === 'area'/.test(estSrc)
    && /sheetHow: x\.sheetHow/.test(estSrc)
    && /if \(w\.sheetHow\) item\.sheetHow = w\.sheetHow/.test(appSrc));
  const ah2 = xsb.Estimate.tryDoorRecipe('门头 6米×2米 铝塑板', {});
  const ahA2 = (ah2.hits || []).find((h) => h.type === 'mat' && h.n === '铝塑板');
  ck('AH', '6×2 常规门头张数/金额一分不变（v429）',
    !!ahA2 && ahA2.sheets === 6 && Math.abs(ahA2.q - 17.88) < 0.02 && !ahA2.sheetHow,
    JSON.stringify(ahA2 && [ahA2.sheets, ahA2.q, ahA2.sheetHow]));
  const ah3 = xsb.Estimate.tryDoorRecipe('门头 6米×3米 铝塑板', {});
  const ahA3 = (ah3.hits || []).find((h) => h.type === 'mat' && h.n === '铝塑板');
  ck('AH', '6×3 高门头 8→9 张（横铺3列×3行），金额同步涨',
    !!ahA3 && ahA3.sheets === 9 && Math.abs(ahA3.q - 26.82) < 0.02
    && ahA3.sheetHow === '横铺' && Math.abs(ahA3.q * ahA3.p - 2547.9) < 0.1,
    JSON.stringify(ahA3 && [ahA3.sheets, ahA3.q, ahA3.sheetHow, ahA3.q * ahA3.p]));
  const ah3Note = xsb.Estimate.resolveItem({ kind: 'mat', n: '铝塑板', u: '㎡', q: ahA3.q, p: 95,
    sheets: ahA3.sheets, sheetHow: ahA3.sheetHow, netQty: ahA3.netQty }, { params: {} });
  ck('AH', '结果行标「(横铺)」且金额=排版后整张面积×单价',
    /约9张\(横铺\)/.test(ah3Note.note) && Math.abs(ah3Note.fee - 26.82 * 95) < 0.001,
    JSON.stringify([ah3Note.note, ah3Note.fee]));
  const ah5 = xsb.Estimate.tryDoorRecipe('门头 6米×3米 5套 铝塑板', {});
  const ahA5 = (ah5.hits || []).find((h) => h.type === 'mat' && h.n === '铝塑板');
  ck('AH', '多套：排版张数×套数（9×5=45），金额同步',
    !!ahA5 && ahA5.sheets === 45 && Math.abs(ahA5.q - 134.1) < 0.02 && ahA5.sheetHow === '横铺',
    JSON.stringify(ahA5 && [ahA5.sheets, ahA5.q]));
  const ahBP = xsb.Estimate.tryDoorRecipe('门头 6米×3米 铝塑板', { extras: { backplate: true } });
  const ahBack = (ahBP.hits || []).find((h) => h.type === 'mat' && h.extraKey === 'backplate');
  ck('AH', '工艺背板维持原面积口径（内置项无 sheet 标记，不套整张制）',
    !!ahBack && ahBack.sheets === 0 && Math.abs(ahBack.q - 19.8) < 0.02,
    JSON.stringify(ahBack && [ahBack.q, ahBack.sheets]));
  const ahEdge = xsb.Estimate.tryDoorRecipe('门头 6米×3米 喷绘布', { extras: { edge: true } });
  const ahEdgeMat = (ahEdge.hits || []).find((h) => h.type === 'mat' && h.extraKey === 'edge');
  ck('AH', '包边窄条同样不套排版，金额口径不变',
    !!ahEdgeMat && ahEdgeMat.sheets === 0 && Math.abs(ahEdgeMat.q - 4.14) < 0.02,
    JSON.stringify(ahEdgeMat && [ahEdgeMat.q, ahEdgeMat.sheets]));
  const ahNoDim = xsb.Estimate.resolveItem({ kind: 'mat', n: '铝塑板', u: '㎡', q: 20, p: 95 }, { params: {} });
  ck('AH', '无尺寸/无铺法字段的普通板材行文字不变',
    !/铺/.test(ahNoDim.note), ahNoDim.note);

  // ---- AI. 常用方案模板扩充 7→17 套 + 老配置 v:4 迁移（2026-11-23）----
  const NEW17 = ['玻璃贴膜整套', '文化墙整套', '楼体亮化整套', 'LED显示屏整套', '喷绘画面更换整套',
    '车身贴整套', '展位布置整套', '道旗刀旗整套', '外墙清洗整套', '发光字维修整套'];
  ck('AI', '10 套常用模板全在内核',
    NEW17.every((n) => (E.SCENE_COMBOS || []).some((c) => c.n === n)),
    NEW17.filter((n) => !(E.SCENE_COMBOS || []).some((c) => c.n === n)).join(','));
  const allIds = new Set(E.WORK_ITEMS.map((x) => x.id));
  const badIds = [];
  (E.SCENE_COMBOS || []).forEach((c) => (c.ids || []).forEach((id) => { if (!allIds.has(id)) badIds.push(c.n + ':' + id); }));
  ck('AI', '全部模板的 ids 都能在定额库找到（无空项）', badIds.length === 0, badIds.join(','));
  // 运行时：新模板能整套展开，面积项标 dim=area
  const aiFilm = (E.SCENE_COMBOS || []).find((c) => c.n === '玻璃贴膜整套');
  const aiHits = gc.estComboHits(aiFilm, { area: 12, desc: '4米×3米', perim: 14 });
  ck('AI', '运行时：玻璃贴膜整套展开且面积项自动算量',
    aiHits.length === 3 && aiHits.filter((h) => h.dim === 'area').length === 2
    && aiHits.some((h) => Math.abs(h.q - 12) < 0.01),
    JSON.stringify(aiHits.map((h) => [h.id, h.q, h.dim])));
  // 老快照迁移（v:3 → v:4）：只补缺的，不改同名
  const aiOldCfg = { v: 3, combos: [{ n: '发光字门头整套', ids: ['i_door'], q: { i_door: 9 } }] };
  const aiMigrated = gc.normalizeEstimateConfig(aiOldCfg);
  ck('AI', 'v3 老快照补齐内核模板（含原 1 套=23，v 升到 7）',
    aiMigrated.combos.length === 23 && aiMigrated.v === 7,
    String(aiMigrated.combos.length) + '/' + aiMigrated.v);
  ck('AI', '迁移不动用户改过的同名模板',
    aiMigrated.combos.find((c) => c.n === '发光字门头整套').q.i_door === 9);
  const aiEmpty = gc.normalizeEstimateConfig({ v: 3, combos: [] });
  ck('AI', '用户主动删光的空数组不被塞回模板', aiEmpty.combos.length === 0, String(aiEmpty.combos.length));
  const aiV4 = gc.normalizeEstimateConfig({ v: 4, combos: [{ n: '发光字门头整套', ids: [], q: {} }] });
  ck('AI', 'v4 配置用户后续删剩 1 套不再被补回旧模板（v7 只补新增的 6 套）',
    aiV4.combos.length === 7 && aiV4.v === 7
    && aiV4.combos.some((c) => c.n === '工地大门整套') && aiV4.combos.some((c) => c.n === '工地围挡整套'),
    String(aiV4.combos.length) + '/' + aiV4.v + '/' + aiV4.combos.map((c) => c.n).join(','));

  // ---- AJ. 工地大门整套（2026-11-23 用户反馈「这种场景方案没有」）----
  const gate = (E.SCENE_COMBOS || []).find((c) => c.n === '工地大门整套');
  ck('AJ', '工地大门整套在内核', !!gate && gate.ids.length >= 8, gate ? String(gate.ids.length) + '项' : '缺失');
  const gateBad = (gate ? gate.ids : []).filter((id) => !allIds.has(id));
  ck('AJ', '工地大门 ids 全部命中定额库', gateBad.length === 0, gateBad.join(','));
  const gateCore = ['i_pitbase','i_pitcon','i_postbase','i_steel','i_fascia','i_led','i_guide'];
  ck('AJ', '覆盖门柱基础/钢架/面板/发光字/公示牌', gateCore.every((id) => gate.ids.includes(id)),
    gateCore.filter((id) => !gate.ids.includes(id)).join(','));
  const gateHits = gc.estComboHits(gate, { area: 12, desc: '6米×2米', perim: 16 });
  ck('AJ', '写尺寸：钢架/面板按面积 12㎡、发光字按 0.3 系数 3.6㎡',
    gateHits.filter((h) => h.dim === 'area').length === 3
    && gateHits.some((h) => h.id === 'i_steel' && Math.abs(h.q - 12) < 0.01)
    && gateHits.some((h) => h.id === 'i_fascia' && Math.abs(h.q - 12) < 0.01)
    && gateHits.some((h) => h.id === 'i_led' && Math.abs(h.q - 3.6) < 0.01),
    JSON.stringify(gateHits.map((h) => [h.id, h.q, h.dim])));
  ck('AJ', '不写尺寸：门柱/公示牌走 q 默认量（2/2/2/6）',
    [2,2,2,6].every((v, i) => Math.abs((gateHits.find((h) => h.id === ['i_pitbase','i_pitcon','i_postbase','i_guide'][i]) || {}).q - v) < 0.01),
    JSON.stringify(['i_pitbase','i_pitcon','i_postbase','i_guide'].map((id) => (gateHits.find((h) => h.id === id) || {}).q)));
  ck('AJ', '智能拆解按方案名命中「工地大门」整句', /工地大门/.test(String(gate.n))
    && String(gate.n).replace(/整套$/, '').length >= 2, gate.n);
  const gateOldV4 = gc.normalizeEstimateConfig({ v: 4, combos: [
    { n: '发光字门头整套', ids: ['i_door'], q: { i_door: 3 } },
    { n: '车身贴整套', ids: ['i_carsticker'], q: {} }
  ] });
  ck('AJ', 'v4 老快照只补新增六套、保留用户已有模板',
    gateOldV4.combos.length === 8 && gateOldV4.v === 7
    && gateOldV4.combos.find((c) => c.n === '发光字门头整套').q.i_door === 3,
    String(gateOldV4.combos.length) + '/' + gateOldV4.v);
  const gateEmpty = gc.normalizeEstimateConfig({ v: 4, combos: [] });
  ck('AJ', '用户删光的空数组不被塞回工地大门', gateEmpty.combos.length === 0, String(gateEmpty.combos.length));
  ck('AJ', 'v5 配置只补 v6+v7 新增五套（旧的不复活）',
    gc.normalizeEstimateConfig({ v: 5, combos: [{ n: '工地大门整套', ids: [], q: {} }] }).combos.length === 6,
    String(gc.normalizeEstimateConfig({ v: 5, combos: [{ n: '工地大门整套', ids: [], q: {} }] }).combos.length));

  // ---- AK. 内置库八类场景补齐（2026-11-23 用户列举：宣传物料/企业文化/导视/围挡/发光字/装饰/展厅/亮化）----
  const fence = E.WORK_ITEMS.find((x) => x.id === 'i_fence');
  ck('AK', '工地围挡新定额已入库（㎡/安装技工）', !!fence && fence.u === '㎡' && fence.tr === 'az', fence ? fence.u + '/' + fence.tr : '缺失');
  const fencePrice = fence ? fence.h * E.defaultConfig().params.rateAz : 0;
  ck('AK', '围挡人工落在 15–20 元/㎡ 行情', fencePrice >= 15 && fencePrice <= 20, fencePrice.toFixed(1));
  const dictHit = (w) => (E.SMART_DICT || []).filter((d) => d.k.some((k) => k.toLowerCase() === w.toLowerCase())).map((d) => d.id);
  ck('AK', '围挡/展厅/企业文化/户外亮化识别词已补',
    dictHit('围挡').includes('i_fence') && dictHit('展厅').includes('i_booth')
    && dictHit('企业文化').includes('i_bgt') && dictHit('户外亮化').includes('i_buildlight'),
    JSON.stringify(['围挡','展厅','企业文化','户外亮化'].map((w) => [w, dictHit(w)])));
  ck('AK', '导视系统识别词绑到成套定额（实测缺口）', dictHit('导视系统').includes('i_guidesys'));
  ck('AK', 'KT板/写真/UV板识别词已补', dictHit('KT板').includes('i_kt') && dictHit('写真').includes('i_kt') && dictHit('UV板').includes('i_uvboard'));
  const NEW3 = ['工地围挡整套', '宣传物料整套', '展厅布置整套'];
  ck('AK', '三套新方案都在内核', NEW3.every((n) => (E.SCENE_COMBOS || []).some((c) => c.n === n)),
    NEW3.filter((n) => !(E.SCENE_COMBOS || []).some((c) => c.n === n)).join(','));
  const allIds2 = new Set(E.WORK_ITEMS.map((x) => x.id));
  const bad2 = [];
  NEW3.forEach((n) => { const c = (E.SCENE_COMBOS || []).find((x) => x.n === n); (c ? c.ids : []).forEach((id) => { if (!allIds2.has(id)) bad2.push(n + ':' + id); }); });
  ck('AK', '三套新方案 ids 全命中定额库', bad2.length === 0, bad2.join(','));
  const fenceC = (E.SCENE_COMBOS || []).find((c) => c.n === '工地围挡整套');
  const fh = gc.estComboHits(fenceC, { area: 60, desc: '30米×2米', perim: 64 });
  ck('AK', '围挡写尺寸：围挡/喷绘按面积 60㎡、画面更换 60㎡',
    fh.filter((h) => h.dim === 'area').length === 3 && fh.some((h) => h.id === 'i_fence' && Math.abs(h.q - 60) < 0.01),
    JSON.stringify(fh.map((h) => [h.id, h.q, h.dim])));
  const promC = (E.SCENE_COMBOS || []).find((c) => c.n === '宣传物料整套');
  const ph = gc.estComboHits(promC, { area: 10, desc: '5米×2米' });
  ck('AK', '宣传物料：KT板/UV板/画面按面积，展架/条幅走固定量',
    ph.filter((h) => h.dim === 'area').length === 3 && ph.some((h) => h.id === 'i_xstand' && Math.abs(h.q - 3) < 0.01),
    JSON.stringify(ph.map((h) => [h.id, h.q, h.dim])));
  const hallC = (E.SCENE_COMBOS || []).find((c) => c.n === '展厅布置整套');
  const hh = gc.estComboHits(hallC, { area: 100, desc: '20米×5米' });
  ck('AK', '展厅写尺寸：展台/背景/亚克力/屏/地毯都按面积',
    hh.filter((h) => h.dim === 'area').length === 5 && hh.some((h) => h.id === 'i_booth' && Math.abs(h.q - 100) < 0.01),
    JSON.stringify(hh.map((h) => [h.id, h.q, h.dim])));
  ck('AK', '导视/发光字方案未被重复新建（已完善的不动，墙面基层+发光字整套为 2026-11-25 新增）',
    (E.SCENE_COMBOS || []).filter((c) => /导视|发光字/.test(c.n)).length === 5,
    String((E.SCENE_COMBOS || []).filter((c) => /导视|发光字/.test(c.n)).map((c) => c.n)));
  const akV5 = gc.normalizeEstimateConfig({ v: 5, combos: [{ n: '工地大门整套', ids: ['i_door'], q: { i_door: 2 } }] });
  ck('AK', 'v5 老快照按名字白名单补五套且不动用户改过的',
    akV5.combos.length === 6 && akV5.v === 7 && akV5.combos.find((c) => c.n === '工地大门整套').q.i_door === 2,
    String(akV5.combos.length) + '/' + akV5.v);
  ck('AK', 'v6 配置只补 v7 两套/空数组都不再被塞回新模板',
    gc.normalizeEstimateConfig({ v: 6, combos: [{ n: '宣传物料整套', ids: [], q: {} }] }).combos.length === 3
    && gc.normalizeEstimateConfig({ v: 5, combos: [] }).combos.length === 0);

  // ---- AL. 单价库精确同名兜底（2026-11-23：输入文字调用单价库参考价）----
  const catHits = (t) => gc.estCatalogTextHits(t);
  ck('AL', '单价库精确同名命中：外墙腻子/底漆 → 8元/㎡、默认量1',
    (() => { const h = catHits('外墙腻子/底漆'); return h.length === 1 && h[0].p === 8 && h[0].q === 1 && h[0].u === '㎡' && h[0].mode === 'qty'; })(),
    JSON.stringify(catHits('外墙腻子/底漆')));
  ck('AL', '名称后写数量（10㎡ / 10平方米）数量与单价正确',
    catHits('外墙腻子/底漆 10㎡')[0].q === 10 && catHits('外墙腻子/底漆10平方米')[0].q === 10
    && catHits('外墙腻子/底漆 10㎡')[0].p === 8,
    JSON.stringify(catHits('外墙腻子/底漆 10㎡')));
  ck('AL', '名称前写数量（10㎡ 外墙腻子/底漆）也识别', catHits('10㎡ 外墙腻子/底漆')[0].q === 10,
    JSON.stringify(catHits('10㎡ 外墙腻子/底漆')));
  ck('AL', '尺寸串按面积：6米×2米 → 12㎡（不是6米）',
    (() => { const h = catHits('铝塑板 6米×2米')[0]; return h.q === 12 && h.u === '㎡' && h.p === 95; })(),
    JSON.stringify(catHits('铝塑板 6米×2米')));
  ck('AL', '一句多个单价库行各自计价、互不覆盖',
    (() => { const h = catHits('外墙腻子/底漆 10㎡、真石漆/涂料 20㎡'); return h.length === 2 && h[0].q === 10 && h[1].q === 20; })(),
    JSON.stringify(catHits('外墙腻子/底漆 10㎡、真石漆/涂料 20㎡')));
  ck('AL', '泛词/未收录词不误命中（室外指引牌、随便什么字）',
    catHits('室外指引牌').length === 0 && catHits('随便什么字').length === 0,
    JSON.stringify([catHits('室外指引牌'), catHits('随便什么字')]));
  ck('AL', '兜底项带单价库来源备注与 calc，便于核对',
    (() => { const h = catHits('外墙腻子/底漆 10㎡')[0]; return /单价库/.test(h.note) && /单价库/.test(h.calc) && h.dim === 'cat'; })(),
    JSON.stringify(catHits('外墙腻子/底漆 10㎡')[0]));
  ck('AL', '智能拆解仅在定额识别失败后才调兜底（接线位置正确）',
    (() => {
      const i = appSrc.indexOf('parsed = estCatalogTextHits(txt)');
      const fail = appSrc.indexOf('if (!parsed || !parsed.length) {', appSrc.indexOf('if (!combo) {', appSrc.indexOf('function estSmartParse')));
      return i > fail && i < appSrc.indexOf('const cands = estFuzzyCandidates(txt)', i);
    })());
  ck('AL', '兜底函数挂载在 estSmartParse 主链路（非孤立函数）',
    appSrc.includes('parsed = estCatalogTextHits(txt);') && typeof gc.estCatalogTextHits === 'function');

  // ---- AM. 条幅尺寸计价口径 + 中文数字数量（2026-11-23 用户截图反馈）----
  const specQ = (t, id) => { const h = E.parseSpec(t).find((x) => x.id === id); return h ? h.q : null; };
  ck('AM', '条幅纯尺寸不再把面积当条数（4.2㎡ → 暂按1条）',
    (() => { const h = E.parseSpec('条幅70*600')[0]; return h && h.id === 'i_bannerhang' && h.q === 1 && h.u === '条' && /请核对/.test(h.calc); })(),
    JSON.stringify(E.parseSpec('条幅70*600')));
  ck('AM', '中文数字「一条」被识别为数量1（截图原输入）',
    (() => { const h = E.parseSpec('条幅70*600 一条')[0]; return h && h.q === 1 && /1条/.test(h.calc) && !/请核对/.test(h.calc); })(),
    JSON.stringify(E.parseSpec('条幅70*600 一条')));
  ck('AM', '中文数字「两条/三条」正确换算',
    specQ('条幅70*600 两条', 'i_bannerhang') === 2 && specQ('条幅70*600 三条', 'i_bannerhang') === 3,
    JSON.stringify([specQ('条幅70*600 两条', 'i_bannerhang'), specQ('条幅70*600 三条', 'i_bannerhang')]));
  ck('AM', '中文数字「幅/张/个/套」量词同样识别',
    specQ('喷绘布两张', 'i_banner') === 2 && specQ('门头 6×2米 两套', 'i_door') === 24,
    JSON.stringify([specQ('喷绘布两张', 'i_banner'), specQ('门头 6×2米 两套', 'i_door')]));
  ck('AM', '中文十/十二正确换算',
    specQ('喷绘布十张', 'i_banner') === 10 && specQ('喷绘布十二张', 'i_banner') === 12,
    JSON.stringify([specQ('喷绘布十张', 'i_banner'), specQ('喷绘布十二张', 'i_banner')]));
  ck('AM', '非数量语境（一定/统一/一路）不被误转',
    E.parseSpec('一定 统一').length === 0 && E.parseSpec('条幅70*600')[0].q === 1);
  ck('AM', '宽高仍按 cm 识别（70*600=4.2㎡ 口径未变）',
    Math.abs(E.parseSize('70*600').area - 4.2) < 0.001 && E.parseSize('70*600').desc === '70×600cm',
    JSON.stringify(E.parseSize('70*600')));
  ck('AM', '明确写阿拉伯数量（3条）不受白名单改动影响',
    specQ('条幅70*600 3条', 'i_bannerhang') === 3, String(specQ('条幅70*600 3条', 'i_bannerhang')));
  ck('AM', '面积单位项（喷绘布）尺寸口径不变',
    specQ('喷绘布 6米×2米', 'i_banner') === 12, String(specQ('喷绘布 6米×2米', 'i_banner')));
  ck('AM', '门头配方路径不受中文数字规范化影响',
    specQ('门头 6×2米 铝塑板', 'i_door') === 12, String(specQ('门头 6×2米 铝塑板', 'i_door')));
  ck('AM', '「面」单位项（道旗/旗帜）白名单本就覆盖、不被改动影响',
    estSrc.includes("const fam = /^(个|套|台|组|面|只|副|件|条|幅)$/"));

  // ---- AN. 项目卡片施工内容摘要：多条不再撑高卡片（2026-11-23 用户截图反馈）----
  const cssSrc2 = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
  const many = Array.from({ length: 23 }, (_, i) => '第' + (i + 1) + '条施工内容');
  const cMany = gc.cardWorkContentText(many, '注意成品保护');
  ck('AN', '23 条施工内容：预览只取前 2 条、总数仍完整记录',
    cMany.total === 23 && cMany.preview === '第1条施工内容 · 第2条施工内容' && cMany.notePreview === '注意成品保护',
    JSON.stringify(cMany));
  ck('AN', '预览超长截断带省略号（不会撑宽卡片）',
    gc.cardWorkContentText(['这是一条特别长的施工内容'.repeat(8)], '').preview.length <= 45
    && /…$/.test(gc.cardWorkContentText(['这是一条特别长的施工内容'.repeat(8)], '').preview));
  ck('AN', '无施工内容但有注意事项：用注意事项兜底预览',
    (() => { const t = gc.cardWorkContentText([], '  现场需要\n 吊篮  '); return t.total === 0 && t.preview === '现场需要 吊篮' && t.notePreview === ''; })(),
    JSON.stringify(gc.cardWorkContentText([], '  现场需要\n 吊篮  ')));
  ck('AN', '空值/null/空白条目被过滤，不产生空 chip',
    (() => { const t = gc.cardWorkContentText(['', null, '   ', '桁架搭建'], ''); return t.total === 1 && t.preview === '桁架搭建'; })(),
    JSON.stringify(gc.cardWorkContentText(['', null, '   ', '桁架搭建'], '')));
  ck('AN', '仅 2 条时不显示多余总数徽标（>2 才显示）',
    gc.cardWorkContentText(['甲', '乙'], '').total === 2
    && /t\.total > 2/.test(appSrc));
  ck('AN', '卡片摘要条已改为单行标签+预览+条数，不再铺开 cc-chips',
    appSrc.includes('<span class="cc-label">施工内容</span>')
    && appSrc.includes('<span class="cc-text">${esc(t.preview)')
    && !appSrc.includes('<div class="cc-chips">'));
  ck('AN', '点击整块仍进完整弹窗（内容一条不删）',
    (() => {
      const i = appSrc.indexOf('class="card-content--clickable"');
      const seg = appSrc.slice(i, i + 200);
      return seg.includes('onclick=') && seg.includes('showProjectContent(');
    })());
  ck('AN', 'CSS 摘要条固定单行省略 + 条数徽标样式齐备',
    /\.card-content--clickable \.cc-text\s*\{[^}]*white-space:\s*nowrap[^}]*text-overflow:\s*ellipsis/s.test(cssSrc2)
    && cssSrc2.includes('.card-content--clickable .cc-count'));
  // P0+P1+方向A：卡片与弹窗同口径去重、去掉重复的注意事项预览
  ck('AN', '卡片调用点先合并碎片再去重（与弹窗同口径）',
    appSrc.includes('const merged = mergeWorkContentFragments(p.workContent);')
    && appSrc.includes('const dedup = visibleWorkContentTags(merged, getWorkItems(p), p.note);'));
  ck('AN', '卡片不再渲染重复的 💬 注意事项预览',
    !appSrc.includes('<span class="cc-note">💬 ${esc(t.notePreview)}</span>'));
  ck('AN', '卡片中文案与预览仍保留（方向A：信息优先）',
    appSrc.includes('<span class="cc-label">施工内容</span>') && appSrc.includes('t.total > 2'));
  ck('AN', '详情区 chips 有高度上限，不再无限铺开',
    /\.proj-content-preview__chips\s*\{[^}]*max-height:\s*76px[^}]*overflow:\s*hidden/s.test(cssSrc2));
  ck('AN', '卡片摘要纯函数接入 renderProjects',
    (() => {
      const i = appSrc.indexOf('function renderProjects()');
      const j = appSrc.indexOf('const t = cardWorkContentText(dedup, p.note)', i);
      return i >= 0 && j > i;
    })());

  // ---- AO. 施工内容碎片合并（2026-11-23 用户截图：21 条太多，实为空格切碎）----
  {
    const mctx = { console };
    vm.createContext(mctx);
    vm.runInContext(slice('function mergeWorkContentFragments(list)', 'const mapProject ='), mctx);
    const merged = mctx.mergeWorkContentFragments([
      '1桁架4.6x3m', '2室外指引牌80x120cm', '5套', '3', '室内引导牌画面尺寸A3', '3张', '4',
      '胸牌证件8x12cm工作人员(20个)技术指导(10个)监督(5个)', '5', '悬挂条幅70x800cm', '1', '条',
      '图片资料', '桁架搭建', '指引牌/易拉宝摆放', '桌牌/台卡摆放（含分牌）', '横幅/吊旗悬挂'
    ]);
    ck('AO', '截图 17 条碎片合并回 10 条', merged.length === 10, String(merged.length));
    ck('AO', '行尾「5套」并回上一条', merged[1] === '2室外指引牌80x120cm 5套', merged[1]);
    ck('AO', '行首序号「3」拼回下一条开头', merged[2] === '3 室内引导牌画面尺寸A3 3张', merged[2]);
    ck('AO', '「1 条」并回悬挂条幅', merged[4] === '5 悬挂条幅70x800cm 1 条', merged[4]);
    ck('AO', '合并幂等（二次读取不再变化）',
      JSON.stringify(mctx.mergeWorkContentFragments(merged)) === JSON.stringify(merged));
    const normal = ['桁架搭建', '发光字6个60厘米', '6米×2米门头', '2026年技能大赛'];
    ck('AO', '带汉字的正常项原样保留',
      JSON.stringify(mctx.mergeWorkContentFragments(normal)) === JSON.stringify(normal));
    ck('AO', '空数组 / 非数组不报错',
      mctx.mergeWorkContentFragments([]).length === 0 && mctx.mergeWorkContentFragments(null).length === 0);
    ck('AO', '读取层 mapProject 接入合并',
      appSrc.includes('workContent: mergeWorkContentFragments('));
    ck('AO', '保存端多行按行切（行内空格保留）',
      appSrc.includes('wcLines.length > 1') && appSrc.includes('line.split(/[、,，]+/)'));
    ck('AO', '保存端再套合并防回环（编辑后不重新切碎）',
      appSrc.includes('const workContent = mergeWorkContentFragments(wcLines.length > 1'));
    ck('AO', '弹窗/详情预览/进度三处显示层兜底合并',
      appSrc.includes('const wc = mergeWorkContentFragments(p.workContent);')
      && appSrc.includes('const wcShow = mergeWorkContentFragments(p.workContent);')
      && appSrc.includes('const raw = mergeWorkContentFragments(p.workContent);'));
    ck('AO', '历史归档绕过mapProject也补合并',
      appSrc.includes('workContent: mergeWorkContentFragments(p.workContent) }));'));

    // ---- AP. 弹窗施工内容标签去重（2026-11-23 用户反馈：明细/注意事项重复铺三遍）----
    const dctx = { console };
    vm.createContext(dctx);
    vm.runInContext(slice('function mergeWorkContentFragments(list)', 'const mapProject ='), dctx);
    const noteReal = '物料明细\n2026年济宁市"技能状元"职业技能大赛\n1桁架4.6x3m\n2室外指引牌80x120cm 5套\n3 室内引导牌画面尺寸A3 3张';
    const itemsReal = [{ n: '桁架搭建' }, { n: '指引牌/易拉宝摆放' }, { n: '桌牌/台卡摆放' }, { n: '横幅/吊旗悬挂' }];
    const wcReal = ['物料明细', '2026年济宁市"技能状元"职业技能大赛', '1桁架4.6x3m', '2室外指引牌80x120cm', '5套',
      '桁架搭建', '指引牌/易拉宝摆放', '桌牌/台卡摆放', '横幅/吊旗悬挂', '独有施工项：现场放线定位'];
    const dedup = dctx.visibleWorkContentTags(wcReal, itemsReal, noteReal);
    ck('AP', '与明细同名的 4 项标签被去掉', dedup.every((s) => !itemsReal.some((it) => it.n === s)),
      JSON.stringify(dedup));
    ck('AP', '注意事项里已有的文字不再单列', !dedup.some((s) => s === '物料明细' || s.indexOf('技能状元') >= 0 || s.indexOf('桁架4.6') >= 0));
    ck('AP', '独有内容仍保留', dedup.some((s) => s.indexOf('现场放线定位') >= 0), JSON.stringify(dedup));
    ck('AP', '全重复时返回空数组（页面显示"已列在下方"而非"未填写"）',
      dctx.visibleWorkContentTags(['桁架搭建'], itemsReal, '').length === 0);
    ck('AP', '无明细无注意事项时原样保留',
      JSON.stringify(dctx.visibleWorkContentTags(['桁架搭建', '现场放线'], [], '')) === JSON.stringify(['桁架搭建', '现场放线']));
    ck('AP', '弹窗/预览/进度三处接线去重函数',
      appSrc.includes('const tags = visibleWorkContentTags(wc, items, p.note);')
      && appSrc.includes('const tagsShow = visibleWorkContentTags(wcShow, items, note);')
      && appSrc.includes('visibleWorkContentTags(raw, getWorkItems(p), p.note)'));
  }

  // ---- AQ. 维修单：实际完成时间 + 维修结论（2026-11-23 用户反馈）----
  {
    ck('AQ', '完成维修表单有维修结论输入框',
      appSrc.includes('id="repairConclusion"') && appSrc.includes('维修结论 / 处理结果'));
    ck('AQ', '提交函数读取并 trim 结论',
      appSrc.includes('const conclusionEl = document.getElementById("repairConclusion")')
      && appSrc.includes('String(conclusionEl.value || "").trim()'));
    ck('AQ', '结论写进 repairOrders 落库对象',
      appSrc.includes('      conclusion,') && appSrc.includes('      completedAt: new Date().toISOString(),'));
    ck('AQ', '详情页显示实际完成时间（仅已完成）',
      appSrc.includes('实际完成时间') && appSrc.includes('ro.completedAt ? `<div class="info-item"'));
    ck('AQ', '详情页显示维修结论（无结论不显示整块）',
      appSrc.includes('ro.conclusion ? `<div class="info-item" style="grid-column:1/-1;"')
      && appSrc.includes('esc(ro.conclusion)'));
    ck('AQ', '唯一完成入口经 openCompleteRepairForm（结论不会绕过）',
      appSrc.includes('openCompleteRepairForm(projectId, ro.id);'));
  }

  // ---- AR. 审计 6 条修复（2026-11-23 用户采纳：P0 三条 + P1#5#6 + P2#8）----
  {
    // P0#1 aggregateCommission 个人提成与日历同源（都从 commissionDaily 按天归期）
    const aggSeg = appSrc.slice(appSrc.indexOf('function aggregateCommission('), appSrc.indexOf('/* 按天 × 人员 × 项目 的提成明细'));
    ck('AR', 'P0#1 byWorker 从 daily 按天聚合（不再 alloc×ratio）',
      aggSeg.includes('byWorker[wid] = (byWorker[wid] || 0) + amt;')
      && aggSeg.includes('if (inPeriod && !inPeriod(d)) return;')
      && !aggSeg.includes('const amt = (Number(it.amount) || 0) * _ratio;'));
    ck('AR', 'P0#1 总额/工费/池仍按 ratio 缩放（只改个人提成分配）',
      aggSeg.includes('totalPool += getCommissionPool(p) * _ratio;'));
    // P0#2+#3 工人卡复用 aggregateCommission
    ck('AR', 'P0#2#3 工人卡两次聚合（累计/本月）都走 aggregateCommission',
      appSrc.includes('const _commAggAll = aggregateCommission(cache.projects, null);')
      && appSrc.includes('const _commAggMonth = aggregateCommission(cache.projects, _inThisMonth);'));
    ck('AR', 'P0#3 本月按施工天归期（monthKey(date) 期间函数），非预约月过滤',
      appSrc.includes('const _inThisMonth = (d) => !!d && monthKey(d) === _commYm;')
      && !appSrc.includes('cache.projects.filter(p => monthKey(p.appointmentTime) === ym)'));
    ck('AR', '工人卡取值读 byWorker（含维修单），不再调 sumWorkerCommission',
      appSrc.includes('_commAggAll.byWorker[w.id]') && appSrc.includes('_commAggMonth.byWorker[w.id]'));
    // P1#5 详情页确认验收权限用 acceptProject（与卡片+执行校验一致）
    ck('AR', 'P1#5 详情页确认验收按钮用 perm.acceptProject',
      appSrc.includes('${perm.acceptProject(p) && !reviewed && p.status === STATUS.DONE ? `<button class="btn small success"'));
    ck('AR', 'P1#5 外层动作组条件含 acceptProject 分支',
      appSrc.includes('((canReview || perm.acceptProject(p)) && !reviewed'));
    // P1#6 名称类 onclick 参数改 escJsAttr
    ck('AR', 'P1#6 门店名 showStoreProjects 用 escJsAttr',
      appSrc.includes("showStoreProjects('${r.id}', '${escJsAttr(r.name)}'")
      && appSrc.includes("showStoreProjects('${s.id}', '${escJsAttr(s.name)}')"));
    ck('AR', 'P1#6 账号名 openUserPermModal 用 escJsAttr',
      appSrc.includes("openUserPermModal('${a.id}', '${escJsAttr(a.name || a.email || a.id)}'"));
    ck('AR', 'P1#6 照片名 openCosLightboxByKey 用 escJsAttr',
      (appSrc.match(/openCosLightboxByKey\('\$\{esc\(it\.key\)\}','\$\{escJsAttr\(it\.name/g) || []).length >= 3);
    // P2#8 卡片入口基于原始内容而非去重预览
    ck('AR', 'P2#8 卡片入口按 merged 判断，不去重后 preview',
      appSrc.includes('const merged = mergeWorkContentFragments(p.workContent);')
      && appSrc.includes('if (!merged.length && !projectPhotoCount(p)) return "";'));
    // 运行时：escJsAttr 防单引号注入（隔离函数体实测）
    {
      const s = appSrc.indexOf('function escAttr(');
      const s2 = appSrc.indexOf('function escJsAttr(');
      // 各函数体到第一个「\n}」结束，避免把中间的 document.addEventListener 等顶层代码带进来
      const cut = (i) => { const t = appSrc.slice(i); return t.slice(0, t.indexOf('\n}') + 2); };
      const escAttrSrc = cut(s), ejSrc = cut(s2);
      const rb = { }; vm.createContext(rb);
      vm.runInContext(escAttrSrc + '\n' + ejSrc + '\nthis.EJ = escJsAttr;', rb);
      const evil = "');alert(1);//";
      const decoded = rb.EJ(evil).replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
      let val; try { val = vm.runInNewContext('"' + decoded + '"'); } catch (_) { val = null; }
      ck('AR', 'P1#6 运行时：注入串经转义后不求值为代码', val === evil, String(val));
    }
  }

  // ---- AS. 全量同步并发削峰（2026-11-23 用户确认：顶部红色横幅「云端同步失败」）----
  {
    ck('AS', '16 张表改走分批查询（不再一次性 Promise.all）',
      appSrc.includes('async function cloudQueryBatch(builders, batchSize = 4)')
      && appSrc.includes('] = await cloudQueryBatch([')
      && !appSrc.includes('] = await Promise.all([\n        cloudQuery(() => sb.from("workers")'));
    ck('AS', '4 个全局设置合并为 1 次 .in 查询',
      appSrc.includes('const GLOBAL_SETTING_KEYS = ["work_timeout_hours", "auto_review_after_accept_hours", "fake_mileage_kmh", "estimate_config"]')
      && appSrc.includes('.in("key", GLOBAL_SETTING_KEYS)')
      && appSrc.includes('async function loadAllGlobalSettings()'));
    ck('AS', '登录/下拉/全量三个入口都改用合并加载',
      (appSrc.match(/await loadAllGlobalSettings\(\);/g) || []).length === 2
      && appSrc.includes('loadAllGlobalSettings(), // 4 个全局设置合并为 1 次查询，避免与 loadAll 叠出并发尖峰'));
    ck('AS', '单个设置读取器支持复用预取行（保留逐键回退）',
      appSrc.includes('async function loadWorkTimeoutSetting(prefetched)')
      && appSrc.includes('async function loadAutoReviewSetting(prefetched)')
      && appSrc.includes('async function loadFakeMileageKmhSetting(prefetched)')
      && appSrc.includes('async function loadEstimateConfig(prefetched)')
      && appSrc.includes('} else if (!prefetched) {'));
    // 运行时：验证分批真的限流、且结果顺序与输入一致
    {
      const bctx = { Promise, console };
      vm.createContext(bctx);
      vm.runInContext(slice('async function cloudQueryBatch(', 'const repo = {'), bctx);
      let peak = 0, active = 0;
      bctx.cloudQuery = async (build) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 5));
        active--;
        return { data: [build()], error: null };
      };
      const got = await bctx.cloudQueryBatch(Array.from({ length: 16 }, (_, i) => () => i), 4);
      ck('AS', '运行时：16 个查询峰值并发 4、结果顺序不变',
        peak === 4 && got.length === 16 && got.every((r, i) => r.data[0] === i), `peak=${peak}`);
    }
  }

  // ---- AT. 可读发布序号（2026-11-23 用户截图：纯哈希看不出迭代先后）----
  {
    const relSrc = fs.readFileSync(path.join(ROOT, 'release.js'), 'utf8');
    const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    ck('AT', '内容指纹仍负责缓存/更新判断（BUILD_NO 不参与哈希）',
      relSrc.includes('.replace(/const BUILD_NO = \\d+;/g, "")')
      && relSrc.includes('const newBuild = curBuild + 1;')
      && swSrc.includes('const CACHE = "ad-install-')
      && swSrc.includes('const VERSION = "'));
    ck('AT', 'release 每次内容变更同时写 sw/app 的 BUILD_NO',
      relSrc.includes('sw = sw.replace(/const BUILD_NO = \\d+;/, `const BUILD_NO = ${newBuild};`)')
      && relSrc.includes('app = app.replace(/const BUILD_NO = \\d+;/, `const BUILD_NO = ${newBuild};`)'));
    ck('AT', 'SW 的 GET_VERSION / 广播都带 buildNo',
      swSrc.includes('version: VERSION, buildNo: BUILD_NO')
      && appSrc.includes('cb && cb(d.version || null, d.buildNo || 0);'));
    ck('AT', '关于弹窗显示 v001 序号 + 构建指纹，徽标也用序号',
      appSrc.includes('const seq = buildNo > 0 ? "v" + String(buildNo).padStart(3, "0") : "";')
      && appSrc.includes('构建指纹 ${esc(appVer)}')
      && appSrc.includes('badge.textContent = seq || appVer || "—";'));
    // 运行时：序号格式 + 老哈希回退
    {
      const vctx = { window: {}, Number, String };
      vm.createContext(vctx);
      vm.runInContext(slice('function appBuildNo()', '// 查询当前 PWA 版本状态'), vctx);
      ck('AT', '运行时：v001 三位补零 + 指纹保留',
        vctx.versionLabel(1, 've8a8a64d') === 'v001（ve8a8a64d）'
        && vctx.versionLabel(12, 'vabcdef12') === 'v012（vabcdef12）', vctx.versionLabel(1, 've8a8a64d'));
      ck('AT', '运行时：无序号时回退原哈希（老客户端不空白）',
        vctx.versionLabel(0, 've8a8a64d') === 've8a8a64d' && vctx.versionLabel(0, '') === '—');
    }
  }

  // ---- AU. 云端上报显示可读序号（2026-11-23 用户追问：云端上报显示哪个）----
  {
    ck('AU', '会话启动 + 节流补报都写完整标签（序号+指纹）',
      (appSrc.match(/app_version: reportedAppVersion\(\)/g) || []).length === 2
      && appSrc.includes('function reportedAppVersion()'));
    ck('AU', '账号管理只显示序号、指纹进 title，老 hash 原样兼容',
      appSrc.includes('const m = String(a.appVersion).match(/^(v\\d+)（(.+)）$/)')
      && appSrc.includes('const shown = m ? m[1] : a.appVersion;')
      && appSrc.includes('a.appVersion === cur || a.appVersion === (window.__APP_VERSION__ || "")'));
    // 运行时：模拟云端上报标签 + 账号页解析
    {
      const uctx = { window: { __BUILD_NO__: 7, __APP_VERSION__: 'vabcdef12' }, Number, String };
      vm.createContext(uctx);
      vm.runInContext(slice('function appBuildNo()', '// 查询当前 PWA 版本状态'), uctx);
      const label = uctx.reportedAppVersion();
      const m = label.match(/^(v\d+)（(.+)）$/);
      ck('AU', '运行时：上报 v007（vabcdef12）', label === 'v007（vabcdef12）', label);
      ck('AU', '运行时：账号页解析出序号 v007 与指纹', !!m && m[1] === 'v007' && m[2] === 'vabcdef12');
    }
  }

  // ---- AV. 快速测算三处改进（2026-11-24 用户截图反馈）----
  {
    // ① 结果页直连「填入工程金额」：必须先回填快照再复用统一写入函数，不另写金额逻辑
    ck('AV', '结果页按钮仅在可编辑工程金额时出现',
      appSrc.includes('const amtInp = document.getElementById("pProjectAmount")')
      && appSrc.includes('if (amtInp && !amtInp.disabled)')
      && appSrc.includes('onclick="estFillAmountFromResult()"')
      && appSrc.includes('↗ 填入工程金额</button>'));
    const fillFn = (() => {
      const i = appSrc.indexOf('function estFillAmountFromResult()');
      return i < 0 ? '' : appSrc.slice(i, appSrc.indexOf('\n}', i) + 2);
    })();
    ck('AV', '填入函数先走回填链路再调统一写入函数（顺序不可反）',
      fillFn.indexOf('estInsertToProject()') >= 0
      && fillFn.indexOf('wcFillProjectAmount()') > fillFn.indexOf('estInsertToProject()')
      && !/pProjectAmount\.value\s*=/.test(fillFn));
    ck('AV', '填入函数有权限/表单/快照三重校验',
      fillFn.includes('inp.disabled') && fillFn.includes('!inp')
      && fillFn.includes('!_estUI.result') && fillFn.includes('_estUI.onInsert'));
    // 顺序实证：onInsert 回调里写 #pCostEstimate 必须早于 closeEstimateModal（否则快照丢失）；
    // wcFillProjectAmount 只读表单 DOM，不碰被置空的 _estUI，所以回填后调用是安全的。
    const onInsertBody = slice('onInsert: ({ snapshot, workNames, result }) => {', '/* ---------- 导出报价单图片');
    ck('AV', '回填回调先写快照再关测算器（快照不丢）',
      onInsertBody.indexOf('hidden.value = JSON.stringify(snapshot)') >= 0
      && onInsertBody.indexOf('closeEstimateModal()') > onInsertBody.indexOf('hidden.value = JSON.stringify(snapshot)'));
    const wcFillFn = slice('function wcFillProjectAmount()', '/* 包工包料填「含料合计」');
    ck('AV', '写入函数只读表单、不依赖测算器状态（回填后可安全调用）',
      !wcFillFn.includes('_estUI') && wcFillFn.includes('getElementById("pProjectAmount")'));
    // ② 主 CTA padding 加宽（比次级按钮更饱满），但窄屏栅格不动
    ck('AV', '主 CTA padding 加宽到 16px（强化主次层级）',
      /\.est-btnrow \.est-parse-btn \{[\s\S]*?padding: 5px 16px;/.test(cssSrc));
    ck('AV', '窄屏三列栅格保持不变（未被加宽破坏）',
      /@media \(max-width: 440px\) \{[\s\S]*?\.est-btnrow \{ display: grid; grid-template-columns: repeat\(3/.test(cssSrc));
    // ③ 常用项抽屉：[hidden] 规则修掉 display:flex 覆盖；两路径文案分工明确
    ck('AV', '匹配条/列表补 [hidden] 规则（未搜索时真隐藏）',
      cssSrc.includes('.est-match-bar[hidden], .est-match-list[hidden] { display: none; }'));
    ck('AV', '加入按钮文案分工：一键全加 / 加入勾选，且说明清楚',
      appSrc.includes('>一键全加</button>') && appSrc.includes('>加入勾选</button>')
      && appSrc.includes('把搜索到的施工项一次全加进清单')
      && appSrc.includes('只加入下面勾选的项'));
  }

  // ===== AW 组：手机端优化（2026-11-24）——回退两行/3+2，改为页签一行、备份移标题栏、定额单行、标题+按钮同行 =====
  {
    // ① 内置定额恢复单行：两行方案已撤（无 data-bi-row flex-wrap、无隐藏表头）
    ck('AW', '内置定额恢复单行（两行方案已撤，不隐藏表头）',
      !/\.est-item-bi\[data-bi-row\] \{ display: flex; flex-wrap: wrap;/.test(cssSrc)
      && !/\.est-item-cols-bi \{ display: none; \}/.test(cssSrc)
      && cssSrc.includes('内置定额项保持单行显示（2026-11-24'));
    // ② 五页签恢复一行（flex:1 1 auto + 内边距收窄），不再 30% 换行
    ck('AW', '配置五页签恢复一行（撤销 3+2、内边距收窄）',
      /\.est-hub-tabs \.est-scene-tab \{ flex: 1 1 auto; padding-left: 3px; padding-right: 3px; font-size: 11\.5px; \}/.test(cssSrc)
      && !/\.est-hub-tabs \.est-scene-tab \{ flex: 1 1 30%; \}/.test(cssSrc));
    // ③ 备份/恢复从页签栏拆出、由 estShowDrawer 检测 est-hub-tabs 注入标题栏
    ck('AW', '备份/恢复从页签栏移除（estCfgHubTabs 不再含备份按钮）',
      !/\$\{tab\("syn", "同义词"\)\}[\s\S]{0,120}est-hub-backup/.test(slice('function estCfgHubTabs(active) {', 'function estOpenCfgHub(tab) {')));
    ck('AW', 'estShowDrawer 检测页签栏自动注入备份按钮（权限对齐）',
      /html\.includes\("est-hub-tabs"\)[\s\S]{0,120}estHubBackupHtml\(\)/.test(appSrc)
      && slice('function estShowDrawer(title, html) {', 'function estCloseDrawer(force) {').includes('headBackup'));
    ck('AW', '标题栏：标题+备份+×同行、未保存徽标换行、按钮缩小',
      /\.est-drawer-head \.est-hub-backup \{ margin-left: auto; padding: 0; \}/.test(cssSrc)
      && /\.est-drawer-head \.est-dirty-badge \{ order: 4; flex: 1 1 100%;/.test(cssSrc));
    // ④ 自定义施工项标题与新增按钮真正同行：order 重排 b=1/btn=2/muted=3（单靠 flex 会被中间的 muted 挤下去）
    ck('AW', '自定义施工项标题与「＋新增项」同行（order 重排，muted 沉底）',
      /\.est-item-head > b \{ order: 1; flex: 0 1 auto; \}/.test(cssSrc)
      && /\.est-item-head > \.btn \{ order: 2; flex: 0 0 auto; margin-left: auto; \}/.test(cssSrc)
      && /\.est-item-head \.est-item-muted \{ order: 3; flex: 1 1 100%; \}/.test(cssSrc));
    // ⑤ 底栏 6 按钮：改为自然宽不折行（强制 3 列等宽会让未识别词折行）
    ck('AW', '底栏管理工具按钮自然宽不折行（未识别词不再拆两行）',
      /\.est-item-io \.btn \{ flex: 0 1 auto; white-space: nowrap; text-align: center; \}/.test(cssSrc)
      && !/\.est-item-io \.btn \{ flex: 1 1 calc\(33\.333% - 6px\)/.test(cssSrc));
    // ⑥ 底部保存按钮与另两个统一 small 尺寸（原来少 small class 导致偏大不协调）
    ck('AW', '「保存施工项」带 small class 与其他底栏按钮尺寸一致',
      /<button class="btn small primary" onclick="estSaveItems\(\)">保存施工项<\/button>/.test(appSrc)
      && !/<button class="btn primary" onclick="estSaveItems\(\)">/.test(appSrc));
    // ⑤ 引导区紧凑化保留：独立 440px 块、在定义之后，且不删三步/示例
    ck('AW', '空态引导区手机端紧凑（独立 440px 块、位于定义之后）',
      /\.est-guide-calc ul \{[^}]*line-height: 1\.65[^}]*\}[\s\S]*@media \(max-width: 440px\) \{\s*\.est-guide-hd \{ margin-bottom: 6px; \}/.test(cssSrc)
      && /\.est-guide-steps \{ gap: 6px; margin-bottom: 8px; \}/.test(cssSrc));
    ck('AW', '引导三步与示例 chip 未删（只压间距不删内容）',
      appSrc.includes('<div class="est-guide-hd">三步出报价</div>')
      && appSrc.includes('试试示例（点一下自动填入）')
      && (appSrc.match(/class="est-guide-chip"/g) || []).length >= 1);
    // ⑥ 示例精简为 1 个普通门头带发光字、写清字数+字高（不锈钢那条已去掉：包边口径易误导）
    const exLine = (appSrc.match(/const ex = \[[^\n]*\]/) || [''])[0];
    const exItems = (exLine.match(/"([^"]+)"/g) || []).map((s) => s.slice(1, -1));
    ck('AW', '测算示例 1 个、门头带发光字、写清字数+字高',
      exItems.length === 1
      && /门头/.test(exItems[0] || '') && /发光字\d+个\d+厘米/.test(exItems[0] || '')
      && !/不锈钢/.test(exItems[0] || '')
      && (() => { const r = E.tryDoorRecipe(exItems[0], {}); return r && r.hits && r.hits.some((h) => h.id === 'i_led' && h.calc && /个字/.test(h.calc)); })(),
      JSON.stringify(exItems));
  }

  // ===== AX 组：单独发光字按「字」计价（2026-11-24，方案 A）=====
  {
    const hitOf = (t) => (E.parseSpec(t) || [])[0] || {};
    ck('AX', '「发光字 5个」按字出项（i_ledz、单位字、q=5）',
      hitOf('发光字 5个').id === 'i_ledz' && hitOf('发光字 5个').q === 5 && hitOf('发光字 5个').u === '字',
      JSON.stringify(hitOf('发光字 5个')));
    ck('AX', '字数在前/字高在后都按字（不误当㎡）',
      ['发光字5个60厘米', '5个发光字', '发光字 3个'].every((t) => {
        const h = hitOf(t); return h.id === 'i_ledz' && h.u === '字';
      }));
    ck('AX', '写了面积仍按㎡走 i_led（不回归）',
      hitOf('发光字 6㎡').id === 'i_led' && hitOf('发光字 6㎡').q === 6
      && hitOf('发光字 2米×1米').id === 'i_led' && Math.abs(hitOf('发光字 2米×1米').q - 2) < 1e-9,
      JSON.stringify([hitOf('发光字 6㎡'), hitOf('发光字 2米×1米')]));
    // 门头配方已按「字数×字高²」算 i_led 面积，补项解析不能再把同一批字按字重复收一遍
    const doorLed = E.tryDoorRecipe('门头 6米×2米，发光字5个60厘米', {}) || { hits: [] };
    ck('AX', '门头配方不重复出 i_ledz、字面积仍按字数×字高²',
      !doorLed.hits.some((h) => h.id === 'i_ledz')
      && doorLed.hits.some((h) => h.id === 'i_led' && Math.abs(h.q - 1.8) < 0.01),
      JSON.stringify(doorLed.hits.filter((h) => h.id === 'i_led' || h.id === 'i_ledz')));
    ck('AX', '按字定额存在且低于按㎡定额（0.7h/字 < 1.6h/㎡）',
      /\['i_ledz','发光字安装（按字）','字',0\.70,/.test(estSrc)
      && /\['i_led','发光字安装（按㎡）','㎡',1\.60,/.test(estSrc));
  }

  // ===== AY 组：不锈钢门头「包边」按周长×侧包深、不套整面排版（2026-11-24）=====
  {
    const cfg = E.defaultConfig();
    const t = '不锈钢发光字门头 5米×1.5米，发光字6个50厘米';
    const r = E.tryDoorRecipe(t, cfg);
    const edge = (r.hits || []).find((h) => h.n === '不锈钢板包边');
    ck('AY', '不锈钢包边按周长×侧包深算出 3㎡（原 14.9㎡ 虚高 3 倍）',
      edge && Math.abs(edge.q - 3) < 0.01 && edge.p === 320 && edge.u === '㎡',
      JSON.stringify(edge && { q: edge.q, p: edge.p }));
    ck('AY', '包边不再套整张排版（无 sheets/sheetHow）、无呆料虚增',
      edge && !edge.sheets && !edge.sheetHow && /周长 13\.0米 × 0\.2米深/.test(edge.calc),
      String(edge && edge.calc));
    ck('AY', '提示词拆解口径完整：骨架/底板/字面积/接线/包边字/字高均正确',
      (r.hits || []).some((h) => h.id === 'i_steel' && Math.abs(h.q - 7.5) < 0.01)
      && (r.hits || []).some((h) => h.id === 'i_fascia' && Math.abs(h.q - 7.5) < 0.01)
      && (r.hits || []).some((h) => h.id === 'i_led' && Math.abs(h.q - 1.5) < 0.01 && /6个字.*字高0\.5米/.test(h.calc))
      && (r.hits || []).some((h) => h.id === 'i_wire' && Math.abs(h.q - 1) < 0.01)
      && (r.hits || []).some((h) => h.n === '不锈钢包边发光字' && Math.abs(h.q - 1.5) < 0.01 && h.p === 600)
      && r.charQty === 6 && Math.abs(r.charH - 0.5) < 1e-9,
      JSON.stringify({ w: r.w, h: r.h, charQty: r.charQty, charH: r.charH }));
    ck('AY', '其他门头配方不受影响（铝塑板/亚克力无不锈钢包边材料行）',
      ['铝塑板门头 6米×2米', '亚克力门头 6米×2米'].every((s) => {
        const rr = E.tryDoorRecipe(s, cfg);
        return !(rr.hits || []).some((h) => h.n === '不锈钢板包边');
      }));
    // 侧包设为 0 的包边不能变 0（与工艺增项一致，按 0.1 米最小收边）
    const flat = E.tryDoorRecipe('不锈钢门头 6米×2米', { depth: 0 });
    const flatEdge = (flat.hits || []).find((h) => h.n === '不锈钢板包边');
    ck('AY', '侧包0时按0.1米最小收边（包边不为0/不为1）',
      flatEdge && flatEdge.q > 0 && /侧包0→按0\.1米收边/.test(flatEdge.calc),
      String(flatEdge && flatEdge.calc));
  }

  // ===== AZ 组：AI 辅助拆解（2026-11-24）=====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    // ① Edge Function：双模式 + 登录态 + 管理员权限 + id 白名单 + 密钥只在服务端
    ck('AZ', 'estimate-ai 函数存在且双模式（polish/suggest）',
      aiSrc.includes('Deno.serve') && aiSrc.includes('mode === "suggest"') && aiSrc.includes('polishSys(') && aiSrc.includes('SUGGEST_SYS'));
    ck('AZ', 'Edge Function 校验登录态（JWT/WebView2 fallback）',
      aiSrc.includes('MISSING_JWT') && aiSrc.includes('parseJwtSub') && aiSrc.includes('x-proxy-fallback'));
    ck('AZ', 'suggest 仅管理员（my_role/my_can 服务端同口径）',
      /anon\.rpc\("my_role"\)/.test(aiSrc) && /anon\.rpc\("my_can", \{ cap: "estimate_manage" \}\)/.test(aiSrc)
      && /role === "manager"/.test(aiSrc) && /profiles"\)\.select\("role"\)/.test(aiSrc));
    ck('AZ', 'LLM 密钥只在服务端环境变量、未配置返回 503',
      aiSrc.includes('Deno.env.get("LLM_API_KEY")') && aiSrc.includes('AI_NOT_CONFIGURED') && aiSrc.includes('503'));
    ck('AZ', 'suggest 建议 id 白名单过滤（防 LLM 幻觉注入非法定额项）',
      /const allowed = new Set/.test(aiSrc) && /allowed\.has\(id\)/.test(aiSrc));
    ck('AZ', 'AI 只输出文本/建议，不返回金额工时（金额链隔离）',
      !/laborFee|projectAmount|commission|splitCents/.test(aiSrc));
    // ② 前端接线：优化按钮 + 批量建议按钮 + 失败降级 + 不自动写入
    ck('AZ', '工具条有「智能转化」按钮且只在云端可用',
      appSrc.includes('id="estAiPolishBtn"') && appSrc.includes('onclick="estAiPolish()"')
      && /MODE !== "cloud" \|\| !sb.*本地模式不支持 AI 辅助/.test(appSrc));
    ck('AZ', '优化结果只回填输入框、不自动拆解（清 lastParsedText 锁）',
      /inp\.value = optimized/.test(appSrc) && /_estUI\.lastParsedText = ""/.test(appSrc));
    ck('AZ', '未识别词「AI 批量建议」仅管理员可见',
      /estCanManage\(\) \? `<button[^`]*estAiSuggestBtn/.test(appSrc)
      && appSrc.includes('onclick="estAiSuggestUnknown()"'));
    ck('AZ', 'AI 建议需逐条采纳+点绑定确认，不自动写同义词',
      appSrc.includes('function estAiAdopt') && /sel\.value = s\.id/.test(appSrc)
      && /function estAiSuggestUnknown[\s\S]{0,1400}?toast\(n \?/.test(appSrc));
    ck('AZ', 'AI 调用失败静默降级、不阻断原拆解',
      /return \{ data: null, error: e \};/.test(appSrc)
      && /走本地兜底/.test(appSrc) && /已用本地词表转化/.test(appSrc));
    ck('AZ', 'AI 辅助 CSS：优化按钮次级样式+建议行+禁用态',
      /\.est-btnrow \.btn\.ghost\.est-ai-btn \{/.test(cssSrc)
      && /\.est-ai-suggest \{/.test(cssSrc) && /\.est-cfg-save \.btn:disabled/.test(cssSrc));
    // ③ 智谱 GLM 通道（2026-11-24）：默认端点/模型 + 400 降级 + 文档说明
    ck('AZ', '默认 LLM 走智谱 GLM（OpenAI 兼容端点 + 免费模型 glm-4-flash）',
      aiSrc.includes('Deno.env.get("LLM_API_URL") || "https://open.bigmodel.cn/api/paas/v4/chat/completions"')
      && aiSrc.includes('Deno.env.get("LLM_MODEL") || "glm-4-flash"')
      && !aiSrc.includes('api.openai.com/v1/chat/completions'));
    ck('AZ', 'LLM_API_URL 兼容 base_url（自动补 /chat/completions，防 404 /v4/）',
      aiSrc.includes('const apiUrlRaw =') && aiSrc.includes('Deno.env.get("LLM_API_URL")')
      && aiSrc.includes('.replace(/\\/+$/, "")')
      && aiSrc.includes('apiUrlRaw + "/chat/completions"')
      && aiSrc.includes('completions$/i.test(apiUrlRaw)'));
    ck('AZ', '智谱不支持 response_format 时 400 降级重试（超时不重试）',
      /for \(let attempt = 0; attempt < 2; attempt\+\+\)/.test(aiSrc)
      && /attempt === 0\s*\? \{ \.\.\.baseBody, response_format/.test(aiSrc)
      && /resp\.status === 400 && attempt === 0\) continue/.test(aiSrc)
      && /catch \(_e\) \{\s*return \{ raw: "", code: "LLM_FAILED" \};\s*\}/.test(aiSrc));
    ck('AZ', '帮助文档写明智谱配置（管理员配 Key、默认 glm-4-flash）',
      helpSrc.includes('智谱 GLM') && helpSrc.includes('glm-4-flash') && helpSrc.includes('LLM_API_KEY'));
    // ④ 错误码透传与分类提示（2026-11-24）：让「AI 优化失败」能看出到底缺什么
    ck('AZ', 'AI 错误码透传：读 error.context body 的 code/error',
      /ctx\.clone\(\)\.json\(\)/.test(appSrc)
      && /e1\.code = String\(j\.code \|\| ""\)/.test(appSrc)
      && /return \{ data: null, error: e1 \}/.test(appSrc));
    ck('AZ', 'AI 失败提示按错误码分类、优化与批量建议共用同一函数',
      /function estAiErrTip\(error, fallback, data\)/.test(appSrc)
      && /AI_NOT_CONFIGURED/.test(appSrc) && /LLM_HTTP_401/.test(appSrc)
      && /non-2xx\|404\|fetch/.test(appSrc)
      && /Failed to send a request to the Edge Function\|FunctionsFetchError/.test(appSrc)
      && (appSrc.match(/estAiErrTip\(/g) || []).length >= 3);
    // ⑤ AI 智能转化（2026-11-24）：口语 → 内核标准施工项，词表驱动、只提醒不编数字
    ck('BA', 'polish 接收前端词表并有兜底表（老前端不报错）',
      /function polishVocabText\(vocab: any\)/.test(aiSrc)
      && aiSrc.includes('FALLBACK_VOCAB')
      && /system = polishSys\(polishVocabText\(body\?\.vocab\)\)/.test(aiSrc));
    ck('BA', 'polish 提示词要求按关键词标准化转写、只提醒不编数字',
      /关键词是系统真正识别的词，必须原样使用/.test(aiSrc)
      && /【绝不编造数字】/.test(aiSrc)
      && /请补字数/.test(aiSrc) && /请补字高/.test(aiSrc));
    ck('BA', 'mapped 标准项 id 走白名单（防幻觉 id 混入展示）',
      /const allowedIds = new Set/.test(aiSrc)
      && /allowedIds\.has\(id\)/.test(aiSrc)
      && aiSrc.includes('return json({ ok: true, text, changes, mapped })'));
    ck('BA', '前端构造内核词表（WORK_ITEMS 名称 + SMART_DICT 同义词）并随 polish 请求发送',
      /function estAiVocab\(\)/.test(appSrc)
      && /Estimate\.WORK_ITEMS/.test(appSrc) && /Estimate\.SMART_DICT/.test(appSrc)
      && /mode: "polish", text: txt, vocab/.test(appSrc));
    ck('BA', '转化结果展示识别到的标准项名称（本地词表二次过滤）',
      /AI 已转成标准项/.test(appSrc)
      && /data\.mapped\.map/.test(appSrc) && /byId\[id\]/.test(appSrc));
    ck('BA', '按钮文案改为「智能转化」、帮助文档同步说明',
      appSrc.includes('✨ 智能转化')
      && helpSrc.includes('AI 智能转化') && helpSrc.includes('标准施工项'));
    ck('BA', '本地兜底口语词表：围蔽/那圈亮的/铁架子→标准项（不依赖 LLM 部署）',
      /const EST_SPOKEN_ALIAS = \[/.test(appSrc)
      && /围蔽/.test(appSrc) && /门口那圈亮的/.test(appSrc) && /做字的铁架子/.test(appSrc)
      && /function estLocalStandardize\(txt\)/.test(appSrc));
    ck('BA', 'AI 结果内核拆不出项时用本地转化覆盖（防「只加单位就返回」）',
      /!estParseCount\(optimized\)/.test(appSrc)
      && /estParseCount\(local\) > estParseCount\(optimized\)/.test(appSrc)
      && /AI 未识别标准项，已用本地词表转化/.test(appSrc));
    ck('BA', '提示词把「关键词替换」列为头号任务（只补单位视为失败）',
      /【头号任务】把口语说法替换成上表出现过的标准关键词/.test(aiSrc)
      && /只补单位、改标点、调整语序【都不算完成】/.test(aiSrc)
      && /text 里【至少出现一个上表关键词】/.test(aiSrc));

    // ⑥ 多套方案候选让用户选（2026-11-25）
    const matchFn = slice('function estComboMatches(', '/* 多套候选选择抽屉');
    const mctx = { window: {}, estComboCoverScore: () => ({ hits: 0, total: 0 }) };
    vm.createContext(mctx); vm.runInContext(matchFn + ';this.M=estComboMatches;', mctx);
    const cs = E.SCENE_COMBOS;
    ck('BB', '单套点名自动展开（不打扰用户）', mctx.M('桁架舞台会场', cs).exact.length === 1);
    ck('BB', '输入同时点名两套 → 产生2个候选（弹选择）',
      mctx.M('桁架舞台会场 文化墙', cs).exact.length === 2);
    ck('BB', '短名「展厅」/「拆除」不误触发整套（防误触保留）',
      mctx.M('展厅', cs).exact.length === 0 && mctx.M('拆除', cs).exact.length === 0);
    ck('BB', '候选分 exact/cover 两层，按强度优先',
      (() => { const r = mctx.M('灯箱广告牌', cs); return Array.isArray(r.exact) && Array.isArray(r.cover); })());
    ck('BB', 'estSmartParse 单套沿用原逻辑、多套弹抽屉、回调跳过重复拦截',
      parseFn.includes('m.exact.length >= 2')
      && parseFn.includes('m.cover.length >= 2')
      && parseFn.includes('estOpenComboChoice(')
      && /if \(!picked && !skipCombo && _estUI\.lastParsedText === txt\)/.test(parseFn));
    ck('BB', '选择抽屉支持「按各项逐条识别」退出整套匹配',
      appSrc.includes('function estPickCombo(i)') && /estSmartParse\(null, true\)/.test(appSrc)
      && appSrc.includes('按各项逐条识别'));
  }

  // BC 组：挖坑按方量 + 免挖坑抑制（2026-11-25）
  {
    const pv = (s) => E.parsePitVolume(s);
    ck('BC', '三维尺寸解析：cm/米/mm 三种写法都换算成 0.288m³',
      Math.abs(pv('60厘米×60厘米×80厘米').v - 0.288) < 1e-6
      && Math.abs(pv('0.6×0.6×0.8米').v - 0.288) < 1e-6
      && Math.abs(pv('600×600×800mm').v - 0.288) < 1e-6);
    ck('BC', '无单位三连按 cm、带小数按米；二维尺寸不误判为坑',
      Math.abs(pv('60×60×80').v - 0.288) < 1e-6
      && pv('6米×2米') === null);
    const pitQty = (t) => E.parseSpec(t, {}).filter((h) => /挖坑/.test(h.n));
    ck('BC', '挖坑写三维尺寸 → 切 m³ 项、q=体积×个数',
      (() => { const h = pitQty('人工挖坑 60厘米×60厘米×80厘米 5个')[0]; return h && h.u === 'm³' && Math.abs(h.q - 1.44) < 1e-6; })());
    ck('BC', '机械挖坑方量同样生效',
      (() => { const h = pitQty('机械挖坑 0.6×0.6×0.8米 3个')[0]; return h && /机械/.test(h.n) && Math.abs(h.q - 0.864) < 1e-6; })());
    ck('BC', '不写尺寸仍按「个」计价（高频路径不变）',
      (() => { const h = pitQty('人工挖坑 5个')[0]; return h && h.u === '个' && h.q === 5; })());
    ck('BC', '同段同义词重复只出一条（挖坑栽立柱不再双算）',
      pitQty('挖坑栽立柱 6个').length === 1 && pitQty('挖坑栽立柱 6个')[0].q === 6);
    ck('BC', '免挖坑判定：水泥地打孔为真、明确挖坑为假',
      E.isNoDigOnly('停车场立柱，水泥地面打孔装膨胀螺丝')
      && E.isNoDigOnly('停车场导视牌 水泥地打孔装螺丝')
      && !E.isNoDigOnly('停车场立柱 挖坑栽柱')
      && !E.isNoDigOnly('挖坑栽柱 6个'));
    ck('BC', '打孔/膨胀螺栓/化学锚栓能被逐项识别',
      (() => {
        const names = E.parseSpec('停车场立柱，水泥地面打孔装膨胀螺丝', {}).map((h) => h.n);
        return names.indexOf('打孔/植筋') >= 0 && names.indexOf('膨胀螺栓固定') >= 0;
      })());
    ck('BC', '水泥地打孔场景不再误出挖坑项',
      E.parseSpec('停车场立柱，水泥地面打孔装膨胀螺丝', {}).every((h) => !/挖坑/.test(h.n)));
    ck('BC', '明确要挖坑的场景仍认挖坑',
      E.parseSpec('停车场立柱 挖坑栽柱', {}).some((h) => /挖坑/.test(h.n)));
    ck('BC', '外墙打孔仍走高空工口径（不被普通打孔抢）',
      E.parseSpec('外墙打孔 5个', {})[0] && E.parseSpec('外墙打孔 5个', {})[0].id === 'i_walldril');
    ck('BC', '整套方案路径也做免挖坑剔除+补打孔',
      appSrc.includes('Estimate.isNoDigOnly(txt)') && appSrc.includes('免挖坑·地面打孔') && appSrc.includes('免挖坑·膨胀螺栓固定'));
  }

  // BD 组：机械工序自动关联设备租赁（2026-11-25）
  {
    // mode:'equip' 计价：量×价进施工费、工时=0、不影响工期与高空设备费
    const ctx0 = { params: E.WORK_PARAM_DEFAULT, height: 'mid', wall: 'flat', distanceKm: 0, transportRate: 2 };
    const base = [{ id: 'i_pitmachvol', n: '机械挖坑', u: 'm³', q: 60 }];
    const eq = [
      { cid: 'equip_excavator', mode: 'equip', n: '挖机台班', u: '台班', q: 1, p: 1000 },
      { cid: 'equip_entry', mode: 'equip', n: '设备进出场费', u: '次', q: 1, p: 1000 },
    ];
    const r0 = E.calculate(base, ctx0), r1 = E.calculate(base.concat(eq), ctx0);
    ck('BD', '设备租赁项进施工费（+2000）', Math.abs((r1.labor + r1.equip) - (r0.labor + r0.equip) - 2000) < 0.01);
    ck('BD', '设备租赁不计工时、不拉长工期、不牵连高空设备费',
      r1.totalHours === r0.totalHours && r1.days === r0.days && r1.equip === r0.equip);
    ck('BD', '单价库补了挖机台班行（1000元/台班）',
      E.CATALOG.some((g) => (g.rows || []).some((r) => /挖机台班/.test(r[1]) && r[2] === 1000)));

    // 纯函数 estEquipHits：台班折算 / 进场费单次 / 防重复
    const eqSrc = slice('const EST_EXCAVATOR_M3_PER_SHIFT', '/* 把机械工序关联的设备租赁项补进清单');
    const rows = {}; E.CATALOG.forEach((g) => (g.rows || []).forEach((r) => { rows[r[1]] = { n: r[1], p: r[2], u: r[3] }; }));
    const price = (nm) => rows[nm] || null;
    const ectx = { window: {}, estCatalogPriceFor: price };
    vm.createContext(ectx); vm.runInContext(eqSrc + ';this.H=estEquipHits;', ectx);
    const EH = ectx.H;
    ck('BD', '方量折算台班：10m³→1台班、150m³→3台班',
      EH([{ id: 'i_pitmachvol', q: 10 }]).some((h) => h.cid === 'equip_excavator' && h.q === 1)
      && EH([{ id: 'i_pitmachvol', q: 150 }]).some((h) => h.q === 3));
    ck('BD', '按个挖坑也能折算台班（400坑→2台班）',
      EH([{ id: 'i_pitmach', q: 400 }]).some((h) => h.cid === 'equip_excavator' && h.q === 2));
    ck('BD', '高空车/吊篮按台班数关联，不该收进场费',
      EH([{ id: 'i_aerial', q: 2 }])[0].n === '曲臂式高空作业平台'
      && EH([{ id: 'i_basket', q: 3 }])[0].p === 800
      && !EH([{ id: 'i_aerial', q: 2 }]).some((h) => /进出场/.test(h.n)));
    ck('BD', '多个挖坑工序合并台班、进场费只收一次',
      (() => {
        const h = EH([{ id: 'i_pitmachvol', q: 10 }, { id: 'i_pitmach', q: 100 }]);
        const exc = h.filter((x) => x.cid === 'equip_excavator'), ent = h.filter((x) => /进出场/.test(x.n));
        return exc.length === 1 && exc[0].q === 2 && ent.length === 1;
      })());
    ck('BD', '清单已有进场费/设备项时不再重复补',
      (() => {
        const h = EH([{ id: 'i_pitmachvol', q: 10 }, { cid: 'equip_entry', q: 1, p: 1000 }]);
        return !h.some((x) => /进出场/.test(x.n)) && h.some((x) => x.cid === 'equip_excavator');
      })());
    ck('BD', '常用项勾选/单条/批量/拆解四入口都接了设备关联',
      (appSrc.match(/estAutoLinkEquip\(1\)/g) || []).length >= 3
      && appSrc.includes('estAutoLinkEquip();'));
    ck('BD', '设备项 UI 标「设备」且不显示「按工时计」切换',
      appSrc.includes('w.mode === "equip" ? \'<span class="est-work-tag">设备</span>\'')
      && appSrc.includes('w.mode !== "equip"'));

    // ===== BE：口语尺寸写法（2026-11-25）=====
    ck('BE', '用户常见 5 种尺寸写法全部识别、面积口径正确',
      ['一半的1.2*2.4', '1.2x2.4', '1米2  2米4', '120*240', '60*90']
        .every((s) => { const v = E.parseSize(s); return v && v.area > 0; })
      && Math.abs(E.parseSize('1.2x2.4').area - 2.88) < 1e-9
      && Math.abs(E.parseSize('1米2  2米4').area - 2.88) < 1e-9
      && Math.abs(E.parseSize('120*240').area - 2.88) < 1e-9
      && Math.abs(E.parseSize('60*90').area - 0.54) < 1e-9);
    ck('BE', '口语尺寸在整句拆解里驱动按面积项算量',
      E.parseSpec('门头 1米2 2米4 铝塑板', {}).some((h) => Math.abs(h.q - 2.88) < 1e-9)
      && E.parseSpec('门头 120*240 铝塑板', {}).some((h) => Math.abs(h.q - 2.88) < 1e-9));
    ck('BE', '中文数字口语「一米二 两米四」在整句里也识别',
      E.parseSpec('门头 一米二 两米四 铝塑板', {}).some((h) => Math.abs(h.q - 2.88) < 1e-9));
    ck('BE', '口语归一化不误伤量词「6米2个」与「1米20」',
      E.normalizeSpokenSize('6米2个门头') === '6米2个门头'
      && E.normalizeSpokenSize('1米20') === '1米20');
    ck('BE', '坑三维/整张板/个位数尺寸口径不受影响',
      E.parsePitVolume('60厘米×60厘米×80厘米').v > 0
      && Math.abs(E.parseSize('3×2米').area - 6) < 1e-9
      && Math.abs(E.parseSize('300×600').area - 18) < 1e-9);

    // ===== BF：墙面基层/涂饰工序（2026-11-25）=====
    const wallId = (t) => E.parseSpec(t, {}).map((h) => h.id);
    ck('BF', '4 个墙面工序项都在内置定额库',
      ['i_walllevel', 'i_putty', 'i_latex', 'i_drywall'].every((id) => E.WORK_ITEMS.some((x) => x.id === id)));
    ck('BF', '单项识别：乳胶漆/找平/石膏板隔墙各自出对项',
      wallId('墙面粉刷乳胶漆 20㎡').includes('i_latex')
      && wallId('墙面找平 20㎡').includes('i_walllevel')
      && wallId('轻钢龙骨石膏板隔墙').includes('i_drywall'));
    ck('BF', '多工序链一次出齐：隔墙→刮腻子→乳胶漆→发光字',
      ['i_drywall', 'i_putty', 'i_latex', 'i_led'].every((id) =>
        wallId('石膏板隔墙 刮腻子 乳胶漆 安装发光字 6米×1米').includes(id)));
    ck('BF', '「隔一层轻钢龙骨石膏板 然后刮腻子乳胶漆」三项都出（连接词不吞项）',
      ['i_drywall', 'i_putty', 'i_latex'].every((id) =>
        wallId('墙面隔一层轻钢龙骨石膏板 然后刮腻子乳胶漆').includes(id)));
    ck('BF', '门头乳胶漆仍走门头配方、不被墙面项重复出项',
      E.isDoorText('门头 6米×2米 乳胶漆')
      && (E.tryDoorRecipe('门头 6米×2米 乳胶漆', {}) || {}).recipe
      && !wallId('门头 6米×2米 乳胶漆').some((id) => ['i_latex', 'i_putty', 'i_drywall'].includes(id)));
    ck('BF', '两套墙面方案在内核且 ids 全命中定额库',
      ['墙面基层涂饰整套', '墙面基层+发光字整套'].every((n) => {
        const c = (E.SCENE_COMBOS || []).find((x) => x.n === n);
        return c && c.ids.length && c.ids.every((id) => E.WORK_ITEMS.some((x) => x.id === id));
      }));
    ck('BF', '墙面+发光字整套写尺寸：各基层按面积、发光字按面积×0.3',
      (() => {
        const c = E.SCENE_COMBOS.find((x) => x.n === '墙面基层+发光字整套');
        const hits = gc.estComboHits(c, { area: 20, desc: '5米×4米' });
        const led = hits.find((h) => h.id === 'i_led');
        const base = hits.filter((h) => ['i_drywall', 'i_walllevel', 'i_putty', 'i_latex'].includes(h.id));
        return base.length === 4 && base.every((h) => Math.abs(h.q - 20) < 0.01)
          && !!led && Math.abs(led.q - 6) < 0.01;
      })());
    ck('BF', '自动补材料支持一工序多材料（石膏板隔墙=板+龙骨）',
      Array.isArray(AUTO.i_drywall) && AUTO.i_drywall.length === 2
      && !!AUTO.i_walllevel && !!AUTO.i_putty && !!AUTO.i_latex
      && ['墙面找平石膏/砂浆', '内墙腻子粉', '内墙乳胶漆', '石膏板（12mm）', '轻钢龙骨']
        .every((n) => n in catPrice));
    ck('BF', 'v6 老配置一次性迁移到 v7 并补两套墙面方案',
      (() => {
        const m = gc.normalizeEstimateConfig({ v: 6, combos: [{ n: '宣传物料整套', ids: [], q: {} }] });
        return m.v === 7 && m.combos.length === 3
          && m.combos.some((c) => c.n === '墙面基层涂饰整套')
          && m.combos.some((c) => c.n === '墙面基层+发光字整套');
      })());

    // ===== BG：不发光字双因子工费（字数基础 + 大字面积附加，2026-11-25）=====
    const bgIds = ['i_carve', 'i_reflect', 'i_wordarea'];
    ck('BG', '3 个不发光字定额项都在内置库且工种/单位正确',
      bgIds.every((id) => !!E.WORK_ITEMS.find((x) => x.id === id))
      && E.WORK_ITEMS.find((x) => x.id === 'i_carve').u === '字'
      && E.WORK_ITEMS.find((x) => x.id === 'i_reflect').u === '字'
      && E.WORK_ITEMS.find((x) => x.id === 'i_wordarea').u === '㎡');
    const bgDict = (id) => E.SMART_DICT.find((r) => r.id === id && r.k.some((k) => /雕刻|反光|不发光/.test(k)));
    ck('BG', 'SMART_DICT 补齐雕刻字/反光字/不发光字识别词',
      !!bgDict('i_carve') && !!bgDict('i_reflect'));
    ck('BG', 'parseWordArea 认单字面积/字高，不误把墙面尺寸当字面积',
      E.parseWordArea('一个字占0.5平方').area === 0.5
      && Math.abs(E.parseWordArea('字高60厘米').area - 0.36) < 1e-9
      && E.parseWordArea('6米×2米的墙') === null);
    const bgParse = (t) => E.parseSpec(t, {});
    ck('BG', '只写字数不追加面积附加行（不重复计价）',
      bgParse('雕刻字 20个').length === 1 && bgParse('雕刻字 20个')[0].q === 20);
    ck('BG', '字数+单字面积 → 按字基础 + 面积附加两行',
      (() => {
        const h = bgParse('雕刻字 3个 每个字占0.5平方');
        return h.length === 2 && h[0].id === 'i_carve' && h[0].q === 3
          && h[1].id === 'i_wordarea' && Math.abs(h[1].q - 1.5) < 1e-9;
      })());
    ck('BG', '字数+字高60厘米 → 面积按 0.36×字数',
      (() => {
        const h = bgParse('雕刻字 5个 字高60厘米');
        return h.length === 2 && Math.abs(h[1].q - 1.8) < 1e-9;
      })());
    ck('BG', '「一个字占0.5平方」被中文数字规范化后仍能取到面积',
      (() => {
        const h = bgParse('雕刻字 1个 一个字占0.5平方');
        return h.length === 2 && h[0].q === 1 && Math.abs(h[1].q - 0.5) < 1e-9;
      })());
    ck('BG', '「不发光字」不再误归发光字（走雕刻字口径）',
      bgParse('不发光字 8个').every((x) => x.id === 'i_carve'));
    ck('BG', '反光字/钛金字同样支持双因子',
      (() => {
        const r = bgParse('反光字 15个 字高40厘米');
        const t = bgParse('钛金字 12个 字高50厘米');
        return r.length === 2 && r[0].id === 'i_reflect' && Math.abs(r[1].q - 2.4) < 1e-9
          && t.length === 2 && t[0].id === 'i_titan' && Math.abs(t[1].q - 3) < 1e-9;
      })());
    ck('BG', '双因子核心：同面积不同字数工费拉开差距',
      (() => {
        const ctx = { params: E.WORK_PARAM_DEFAULT, height: 'low', wall: 'flat', distanceKm: 0, transportRate: 2 };
        const big = E.calculate(bgParse('雕刻字 1个 一个字占0.5平方'), ctx);
        const small = E.calculate(bgParse('雕刻字 15个 每个字约0.033平方'), ctx);
        return small.totalHours > big.totalHours * 4 && small.labor > big.labor * 4;
      })());
    ck('BG', '门头发光字路径不受双因子影响（不追加面积行）',
      bgParse('门头 6米×2米 铝塑板 发光字5个60厘米').every((x) => x.id !== 'i_wordarea'));
    ck('BG', '只写总面积无字数不叠面积行（避免同工程量收两遍）',
      bgParse('雕刻字 6平方米').length === 1);
  }

  // ===== BH 组：门头文字厚度自动计入用料（2026-11-25）=====
  {
    const pt = (t) => E.parseDoorThickness(t);
    ck('BH', '「厚20厘米 / 厚度0.3米 / 30公分厚」三种写法都认',
      pt('门头 6米×2米 厚20厘米').meters === 0.2
      && pt('门头 6米×2米 厚度 0.3米').meters === 0.3
      && pt('门头 6米×2米 30公分厚的箱体').meters === 0.3);
    ck('BH', '中文数字与 200mm 大厚度也认',
      pt('门头 6米×2米 厚二十公分').meters === 0.2 && pt('门头 6米×2米 厚200mm').meters === 0.2);
    ck('BH', '3mm 板厚 / 1.2mm 包边料厚不算箱体厚度',
      pt('门头 6米×2米 铝塑板3mm厚') === null && pt('门头 6米×2米 1.2mm不锈钢包边') === null);
    ck('BH', '「发光字厚5厘米」是字壳厚，不误伤箱体厚度',
      pt('门头 6米×2米 发光字厚5厘米') === null
      && pt('门头 6米×2米 厚30厘米 发光字厚5厘米').meters === 0.3);
    const base = '门头 6米×2米 铝塑板';
    const cfgBH = { depth: 0.2, thick: 0, gap: 0.6 };
    const r0 = E.tryDoorRecipe(base, cfgBH);
    const r1 = E.tryDoorRecipe(base + ' 厚30厘米', cfgBH);
    const qOf = (r, n) => (r.hits.find((h) => h.n === n) || {}).q || 0;
    ck('BH', '写厚度后侧包 depth=0.3、骨架双层 + 连接撑',
      r1.thickness === 0.3 && r1.depth === 0.3 && r1.frame.layers === 2 && r1.frame.braceN > 0,
      JSON.stringify(r1.frame));
    ck('BH', '写厚度后方管与板材用量同步上涨（不是只改文案）',
      qOf(r1, '热镀锌方管(骨架)') > qOf(r0, '热镀锌方管(骨架)')
      && qOf(r1, '铝塑板') > qOf(r0, '铝塑板')
      && qOf(r1, '铝塑板') === 20.86,
      JSON.stringify([qOf(r0, '热镀锌方管(骨架)'), qOf(r1, '热镀锌方管(骨架)'), qOf(r0, '铝塑板'), qOf(r1, '铝塑板')]));
    ck('BH', '本次识别不写回配置，下一条无厚度文字仍走旧口径',
      cfgBH.depth === 0.2 && cfgBH.thick === 0
      && E.tryDoorRecipe(base, cfgBH).frame.layers === 1);
    ck('BH', '不写厚度时旧口径一分不变（v429）',
      r0.thickness === 0 && r0.frame.layers === 1 && qOf(r0, '铝塑板') === 17.88);
    ck('BH', '板厚/字厚写法不改变门头用料',
      E.tryDoorRecipe(base + ' 铝塑板3mm', cfgBH).frame.layers === 1
      && E.tryDoorRecipe(base + ' 发光字厚5厘米', cfgBH).frame.layers === 1);
    ck('BH', 'app：拆解提示明确显示厚度已计入', appSrc.includes('厚度${door.thickness}米已计入侧包和双层骨架'));
    const helpBH = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
    ck('BH', '说明书补充厚度写法与板厚不误判', helpBH.includes('写上门头厚度会自动算进用料')
      && helpBH.includes('3mm 铝塑板') && helpBH.includes('厚度0.3米已计入侧包和双层骨架'));
  }

  // ===== BI 组：门头离地净高自动算脚手架（2026-11-25）=====
  {
    const pc = (t) => E.parseDoorClearance(t);
    ck('BI', '「离地3米 / 距地面2.4米 / 门头底离地80公分」都认',
      pc('门头 6米×2米 离地3米').meters === 3
      && pc('门头 6米×2米 距地面2.4米').meters === 2.4
      && pc('门头 6米×2米 门头底离地80公分').meters === 0.8);
    ck('BI', '台阶文字本身不当离地高度',
      pc('门头 6米×2米 门口有三级台阶') === null
      && pc('门头 6米×2米 台阶3级') === null);
    const cfgBI = { extras: { scaffold: true } };
    const baseBI = '门头 6米×2米 铝塑板';
    const r0 = E.tryDoorRecipe(baseBI, cfgBI);
    const r1 = E.tryDoorRecipe(baseBI + ' 离地3米 门口有台阶', cfgBI);
    const scOf = (r) => r.hits.find((h) => h.extraKey === 'scaffold');
    const s0 = scOf(r0), s1 = scOf(r1);
    ck('BI', '写离地3米：有效高5米、脚手架 4组→8组',
      r0.clearance === 0 && r0.scaffoldHeight === 2 && s0.q === 4
      && r1.clearance === 3 && r1.scaffoldHeight === 5 && s1.q === 8,
      JSON.stringify([s0 && s0.q, s1 && s1.q]));
    ck('BI', '组数计算行写明离地+门头高，台阶不抵减',
      /离地3米/.test(s1.calc) && /有效高 5米/.test(s1.calc) && /门头2米\+离地3米/.test(s1.calc));
    ck('BI', '不写离地高度旧口径一分不变（v429）',
      E.tryDoorRecipe(baseBI, cfgBI).hits.find((h) => h.extraKey === 'scaffold').q === 4);
    ck('BI', 'app：离地净高自动勾选脚手架并提示组数',
      appSrc.includes('door.scaffoldHeight > (Estimate.SCAFFOLD_REACH || 1.8)')
      && appSrc.includes('脚手架按有效高${door.scaffoldHeight}米=${Estimate.scaffoldSets(door.w, door.scaffoldHeight)}组')
      && appSrc.includes('写了台阶但未写离地X米'));
    const helpBI = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
    ck('BI', '说明书补充离地高度/台阶口径', helpBI.includes('离地高度 / 台阶与脚手架')
      && helpBI.includes('离地净高＋门头高') && helpBI.includes('台阶只当通行方式，不抵减高度'));
  }

  // ===== BJ 组：改字重拆先问累加还是重算（2026-11-25）=====
  {
    const choiceSrc = slice('function estOpenParseModeChoice(txt) {', '/* 智能拆解：调内核 parseSpec');
    const inp = { value: '门头 6米×2米 离地3米' };
    const cc = {
      window: {}, console, document: { getElementById: (id) => id === 'estInput' ? inp : id === 'estGlowHint' ? { hidden: false } : null },
      modal: { open: (t, b, o) => { cc._opened = { t, b, o }; }, close: () => { cc._closed = true; } },
      _estUI: { work: [{ n: '旧项' }], doorExtras: { edge: true }, lastParsedText: '门头 6米×2米', autoHistId: 'h1' },
      estRenderDoorExtras: () => {}, renderEstimateWorkList: () => {}, estRecalc: () => {},
      estSmartParse: () => { cc._reparsed = true; },
    };
    vm.createContext(cc);
    vm.runInContext(choiceSrc, cc);
    cc.estOpenParseModeChoice(inp.value);
    ck('BJ', '改字重拆弹窗同时给「累加 / 清除重算 / 取消」',
      /重复拆解 · 累加还是重算/.test(cc._opened.t)
      && cc._opened.b.includes("estChooseParseMode('append')")
      && cc._opened.b.includes("estChooseParseMode('replace')")
      && cc._opened.b.includes('modal.close()'));
    cc.estChooseParseMode('replace');
    ck('BJ', '选「清除重算」：清空清单/工艺勾选/原文锁后重拆',
      cc._estUI.work.length === 0 && !cc._estUI.doorExtras.edge && cc._estUI.lastParsedText === ''
      && cc._estUI.autoHistId === null && cc.window._estParseForced === inp.value
      && cc._closed && cc._reparsed);
    cc._estUI.work = [{ n: '保留的旧项' }]; cc._closed = false; cc._reparsed = false;
    cc.estChooseParseMode('append');
    ck('BJ', '选「累加」：旧清单不动，直接按新原文重拆',
      cc._estUI.work.length === 1 && cc._closed && cc._reparsed);
    ck('BJ', 'estSmartParse 只在「原文不同且清单非空」时弹选择',
      /window\._estParseForced !== txt && !picked && !skipCombo && _estUI\.lastParsedText/.test(parseFn)
      && /_estUI\.lastParsedText !== txt && \(_estUI\.work \|\| \[\]\)\.length/.test(parseFn)
      && /if \(!picked && !skipCombo && _estUI\.lastParsedText === txt\)/.test(parseFn));
    const helpBJ = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
    ck('BJ', '说明书说明改字重拆的选择逻辑', helpBJ.includes('改文字再拆会先问一句')
      && helpBJ.includes('清除后重新测算') && helpBJ.includes('数量翻倍'));
  }

  // ===== BK：门头工艺预置价口径——主干已含侧包/包边时隐藏包边类，防重复计价 =====
  {
    const withSide = ['alc', 'ss', 'acr', 'pvc', 'generic'];
    const withoutSide = ['lightbox', 'spray', 'lvf', 'stone', 'coat', 'sheet'];
    withSide.forEach((k) => {
      const keys = E.doorExtraRedundantKeys(E.DOOR_RECIPES[k]);
      ck('BK', k + ' 主干含侧包/包边，包边类标记为重复', keys.includes('edge') && keys.includes('ssedge'));
    });
    withoutSide.forEach((k) => {
      const keys = E.doorExtraRedundantKeys(E.DOOR_RECIPES[k]);
      ck('BK', k + ' 主干不含侧包，包边类仍可勾', keys.length === 0);
    });
    const txt = '门头 6米×2米，发光字5个60厘米';
    const cfg = { extras: { edge: true, ssedge: true, scaffold: true } };
    const before = JSON.stringify(cfg.extras);
    const r = E.tryDoorRecipe(txt, cfg);
    ck('BK', '通用配方：默认勾选包边也不再重复出项',
      !r.hits.some((h) => h.extraKey === 'edge' || h.extraKey === 'ssedge')
      && r.hits.some((h) => h.extraKey === 'scaffold'));
    ck('BK', '过滤只读 cfg.extras，不改调用方对象', JSON.stringify(cfg.extras) === before);
    ck('BK', '内核回传 hiddenExtras 供 UI 同步清状态',
      (r.hiddenExtras || []).includes('edge') && (r.hiddenExtras || []).includes('ssedge'));
    const lb = E.tryDoorRecipe('门头 6米×2米 灯箱布', { extras: { edge: true } });
    ck('BK', '灯箱布不含侧包，勾包边仍出项', lb.hits.some((h) => h.extraKey === 'edge'));
    ck('BK', 'UI 按配方隐藏重复项并说明原因',
      /doorExtraRedundantKeys\(recipe\)/.test(appSrc)
      && appSrc.includes('主干已含侧包，包边类不再重复列出')
      && /door\.hiddenExtras/.test(appSrc));
    const helpBK = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
    ck('BK', '说明书说明预置价算式与隐藏规则',
      helpBK.includes('预置价怎么算') && helpBK.includes('主干已含侧包的配方自动隐藏'));
  }

  // ===== BL：AI 合理性复核（第三方视角，只读建议）=====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const helpBL = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
    const reviewFn = appSrc.slice(appSrc.indexOf('async function estAiReview()'), appSrc.indexOf('/* 重复拆解选择', appSrc.indexOf('async function estAiReview()')));
    ck('BL', 'Edge Function 有 review 模式与中立第三方提示词',
      aiSrc.includes('mode === "review"') && aiSrc.includes('REVIEW_SYS')
      && aiSrc.includes('第三方') && aiSrc.includes('禁止把推测写成事实') && aiSrc.includes('最多 5 条'));
    ck('BL', 'review 只收白名单字段，客户名/工程金额不进 LLM',
      /\["totalHours", "labor", "equip", "transportFee", "matFee", "auxFee", "floor", "construction", "grand"\]/.test(aiSrc)
      && !/projectAmount|customerName/.test(aiSrc.slice(aiSrc.indexOf('mode === "review"'), aiSrc.indexOf('system = REVIEW_SYS'))));
    ck('BL', 'review 未套用 suggest 的管理员门槛',
      aiSrc.includes('if (mode === "suggest") {') && !aiSrc.includes('mode === "review" || mode === "suggest"'));
    ck('BL', 'review 输出枚举 + 条数/长度裁剪 + 空回复报错',
      aiSrc.includes('"ok", "check", "risk"') && aiSrc.includes('slice(0, 5)')
      && aiSrc.includes('EMPTY_AI_REVIEW'));
    ck('BL', '结果页有「AI 复核」按钮且仅云端出现',
      appSrc.includes('id="estAiReviewBtn"') && appSrc.includes('onclick="estAiReview()"')
      && /MODE === "cloud"\) btns\.push\(`<button class="btn outline" id="estAiReviewBtn"/.test(appSrc));
    ck('BL', '复核失败只 toast，函数体不碰清单/金额',
      reviewFn.includes('estAiErrTip(error, "AI 复核失败，已保留当前清单和金额（未应用建议）", data)')
      && !/_estUI\.work\s*=/.test(reviewFn) && !/estRecalc\(/.test(reviewFn));
    ck('BL', '复核报告字段全部转义（防模型夹带 HTML）',
      /esc\(\(s && s\.title\)/.test(appSrc) && /esc\(\(data && data\.summary\)/.test(appSrc)
      && /esc\(\(s && s\.action\)/.test(appSrc));
    ck('BL', 'CSS 有复核卡片与高/中严重度样式',
      cssSrc.includes('.est-ai-review-item.is-high') && cssSrc.includes('.est-ai-review-item.is-mid')
      && cssSrc.includes('.est-ai-review-top'));
    ck('BL', '说明书说明复核范围与只读边界',
      helpBL.includes('AI 方案复核（可选）') && helpBL.includes('只作建议')
      && helpBL.includes('不修改清单'));

    // 运行时：真实函数切片 + 最小 mock，验证 payload 字段与报告渲染
    const escFn = appSrc.slice(appSrc.indexOf('function esc(str)'), appSrc.indexOf('\n}', appSrc.indexOf('function esc(str)')) + 2);
    const rvParts = [
      'let _estUI = null;',
      escFn,
      slice('function estCostScope(', 'function estItemCat('),
      slice('function estItemCat(', '/* 纯计算：内部成本行'),
      slice('function estAiReviewPayload()', 'async function estAiReview()'),
      slice('async function estAiReview()', '/* 重复拆解选择'),
    ].join('\n');
    const btn = { disabled: false, textContent: '' };
    const rc = {
      console,
      document: { getElementById: (id) => id === 'estInput' ? { value: '门头 6米×2米，发光字5个60厘米' } : (id === 'estAiReviewBtn' ? btn : null) },
      estCfg: () => ({ params: { rateNormal: 36, rateHigh: 75, rateAz: 48, rateJz: 60, auxRatio: 6, minStart: 300 } }),
      modal: { open: (t, b, o) => { rc.__modal = { t, b, o }; }, close: () => { rc.__closed = true; } },
      toast: (m) => { rc.__toast = m; },
      // 真实 estAiErrTip 的简化桩：错误码 → 人话，验证失败分支只提示
      estAiErrTip: (e, fallback) => String((e && e.message) || fallback).replace('AI_NOT_CONFIGURED', 'AI 服务未配置：请管理员配置'),
      estAiInvoke: async (body) => {
        rc.__body = body;
        return { data: { ok: true, verdict: 'check', summary: '<img src=x onerror=1>建议核对',
          reviewChecks: [{ group: '拆解', text: '原文没写字高' }, { group: '组合', text: '高处作业无脚手架' }],
          suggestions: [{ level: 'high', cat: '拆解', title: '<b>包边重复</b>', why: '侧包已含', action: '取消勾选' }] }, error: null };
      },
    };
    vm.createContext(rc);
    vm.runInContext(rvParts, rc);
    vm.runInContext(" _estUI = { work: [{ id: 'i_steel', q: 12 }], height: 'low', wall: 'flat', result: { rows: [{ n: '钢架焊接', u: '㎡', q: 12, hours: 9.6, fee: 345.6, note: '骨架' }], totalHours: 9.6, labor: 345.6, grand: 1200, distanceKm: 0, roundTrip: false, crew: { level: '1人' } } };", rc);
    await rc.estAiReview();
    ck('BL', 'payload 带原文/清单逐项/汇总/条件/参数，不夹带工程金额',
      rc.__body && rc.__body.mode === 'review'
      && /门头 6米×2米/.test(rc.__body.text)
      && rc.__body.items.length === 1 && rc.__body.items[0].h === 9.6
      && rc.__body.items[0].cat === 'labor' && rc.__body.items[0].scope === 'labor'
      && rc.__body.totals.grand === 1200 && rc.__body.cond.wall === 'flat'
      && rc.__body.params.rateNormal === 36 && !('projectAmount' in rc.__body));
    ck('BL', '报告弹窗展示总评/严重度/依据/动作，并按拆解/组合分组',
      !!rc.__modal && rc.__modal.t === 'AI 方案复核'
      && rc.__modal.b.includes('建议核对') && rc.__modal.b.includes('高')
      && rc.__modal.b.includes('依据：侧包已含') && rc.__modal.b.includes('建议：取消勾选')
      && rc.__modal.b.includes('① 拆解合理性') && rc.__modal.b.includes('② 施工组合合理性')
      && rc.__modal.b.includes('原文没写字高') && rc.__modal.b.includes('高处作业无脚手架'));
    ck('BL', 'AI 文本里的 HTML 被转义，按钮状态复位',
      rc.__modal.b.includes('&lt;b&gt;包边重复&lt;/b&gt;') && !rc.__modal.b.includes('<img src=x')
      && btn.disabled === false && btn.textContent === '🤖 AI 方案复核');
    rc.__modal = null; rc.__toast = '';
    rc.estAiInvoke = async () => ({ data: null, error: new Error('AI_NOT_CONFIGURED') });
    await rc.estAiReview();
    ck('BL', 'AI 未配置时给人话提示，不弹报告、不改清单',
      rc.__modal === null && /AI 服务未配置/.test(rc.__toast || '')
      && rc.__body.mode === 'review' && btn.disabled === false);
  }

  // ===== BM：方案复核（拆解合理性 + 施工组合合理性，不再做价格/成本对照）=====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const reviewFn = appSrc.slice(appSrc.indexOf('async function estAiReview()'), appSrc.indexOf('/* 重复拆解选择', appSrc.indexOf('async function estAiReview()')));
    const openFn = appSrc.slice(appSrc.indexOf('function estOpenAiReview(data)'), appSrc.indexOf('async function estAiReview()'));
    const reviewBranch = aiSrc.slice(aiSrc.indexOf('} else if (mode === "review")'), aiSrc.indexOf('} else if (mode === "price")'));
    ck('BM', '提示词宁缺毋滥、禁无指向套话，禁止空话，逐条回应内置核对',
      aiSrc.includes('输出 1–5 条 suggestions') && aiSrc.includes('宁缺毋滥')
      && aiSrc.includes('严禁输出「未见明显问题」') && aiSrc.includes('无指向套话')
      && aiSrc.includes('必须逐条回应') && aiSrc.includes('【拆解合理性】') && aiSrc.includes('【施工组合合理性】'));
    ck('BM', '内置规则按拆解/组合覆盖尺寸/重复/漏项/工序措施',
      /function reviewClues\(/.test(aiSrc) && aiSrc.includes('【拆解】') && aiSrc.includes('【组合】')
      && aiSrc.includes('离地高度') && aiSrc.includes('包边') && aiSrc.includes('运输费为0')
      && aiSrc.includes('工序链') && !aiSrc.includes('起步价占合计比例偏高'));
    ck('BM', '内置规则补足 AI 偷懒漏掉的条目，且归入对应组',
      /if \(suggestions\.length < 3\)/.test(aiSrc)
      && aiSrc.includes('cat: c.indexOf("【组合】") === 0 ? "组合" : "拆解"')
      && aiSrc.includes('/组|施工|工序|工艺|措施/.test(rawCat)'));
    ck('BM', 'review 分支不再注入行业成本区间、不发联网行情请求',
      !reviewBranch.includes('industryPriceCheck') && !reviewBranch.includes('reviewWebRefs')
      && !reviewBranch.includes('内置行业成本价对照') && reviewBranch.includes('reviewChecks')
      && reviewBranch.includes('不评价单价/成本高低'));
    ck('BM', '报告按两组展示内置核对与 AI 建议，不再出现成本价对照表/联网态',
      openFn.includes('reviewChecks') && openFn.includes('① 拆解合理性') && openFn.includes('② 施工组合合理性')
      && openFn.includes('est-ai-review-checks') && !openFn.includes('industryCheck')
      && !openFn.includes('data.webRefs') && !openFn.includes('成本价行业对照')
      && reviewFn.includes('estAiInvoke(estAiReviewPayload(), 35000)'));
    ck('BM', '说明书写明方案复核与联网密钥只用于客户报价复核',
      helpSrc.includes('AI 方案复核（可选）') && helpSrc.includes('拆解合理性')
      && helpSrc.includes('施工组合合理性') && helpSrc.includes('REVIEW_SEARCH_PROVIDER')
      && helpSrc.includes('REVIEW_SEARCH_KEY') && helpSrc.includes('supabase functions deploy estimate-ai'));
    ck('BM', '按钮改为「AI 方案复核」，仍只出建议不碰清单',
      appSrc.includes('>🤖 AI 方案复核</button>') && !/_estUI\.work\s*=/.test(reviewFn));
    ck('BM', '方案复核弹窗加宽且不启用预约表单拖动/最小化',
      appSrc.includes('reportWide: true') && appSrc.includes('modal--report')
      && cssSrc.includes('.modal--report { width: min(94vw, 900px); max-width: 900px; }')
      && cssSrc.includes('.est-ai-review-sec-head'));
    ck('BM', '客户报价复核明确写「客户报价口径」并指向方案复核入口',
      appSrc.includes('行业价格对照（客户报价口径，内部参考）')
      && appSrc.includes('这里比的是<b>当前报价单价</b>，不是内部成本价')
      && appSrc.includes('请到测算结果页点「AI 方案复核」'));
  }

  // ===== BN：智能加价与客户报价单 =====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const calcSrc = slice('function estCustomerQuoteCalc(', 'function estCustomerQuoteRows()');
    const quoteFn = slice('function estOpenCustomerQuote(', 'async function estAiPrice(forceRefresh)');
    const bnExportFn = slice('/* 客户报价单导出', '/* 重复拆解选择');
    const bnTextSrc = slice('function estCustomerQuoteText(', 'function estCustomerQuotePrintHtml(');
    ck('BN', 'Edge Function 有 price/quotecheck 两模式与分项利润护栏',
      aiSrc.includes('mode === "price"') && aiSrc.includes('mode === "quotecheck"')
      && /const PROFIT_GUARD/.test(aiSrc) && aiSrc.includes('clampProfitRate')
      && aiSrc.includes('PRICE_SYS') && aiSrc.includes('QUOTE_SYS'));
    ck('BN', 'AI 只给加价率不吐金额，越界裁剪、统一比例回退',
      aiSrc.includes('rates = raw.map') && aiSrc.includes('new Set(rates.map((r) => r.rate)).size === 1')
      && aiSrc.includes('不输出成本价、不输出绝对金额'));
    ck('BN', '客户价复核与成本复核分开，且都有 ≥3 条硬要求',
      aiSrc.includes('quoteClues(') && /至少 3 条、最多 5 条/.test(aiSrc)
      && aiSrc.includes('EMPTY_QUOTE_REVIEW') && aiSrc.includes('mode === "quotecheck"'));
    ck('BN', '结果页两个 AI 按钮分工明确',
      appSrc.includes('id="estPriceBtn"') && appSrc.includes('onclick="estAiPrice()"')
      && appSrc.includes('onclick="estAiQuoteCheck()"') && appSrc.includes('>💰 智能加价</button>')
      && appSrc.includes('function estReopenCustomerQuote()'));
    ck('BN', '客户报价单只显示客户价，不写金额链',
      appSrc.includes('客户报价单（不含税）') && appSrc.includes('cq-internal')
      && !/cost_estimate\s*=/.test(quoteFn) && !/projectAmount\s*=/.test(quoteFn)
      && !/estRecalc\(/.test(quoteFn));
    ck('BN', '说明书写明分项加价与客户价边界',
      helpSrc.includes('智能加价（客户报价）') && helpSrc.includes('不是整单统一乘一个百分比')
      && helpSrc.includes('不显示成本和利润率'));
    ck('BN', 'CSS 有客户报价单与内部折叠样式，单价/小计表头与数字同右对齐',
      cssSrc.includes('.cq-table') && cssSrc.includes('.cq-total') && cssSrc.includes('.cq-internal')
      && /\.cq-table th:nth-child\(3\), \.cq-table th:nth-child\(4\)/.test(cssSrc)
      && /\.cq-table td:nth-child\(3\), \.cq-table td:nth-child\(4\)/.test(cssSrc));
    ck('BN', '客户可见列统一叫「报价单价」，不再叫「客户单价」',
      quoteFn.includes('<th>报价单价</th>') && !quoteFn.includes('客户单价')
      && bnTextSrc.includes('报价单价') && !bnTextSrc.includes('客户单价')
      && bnExportFn.includes('报价单价') && !bnExportFn.includes('客户单价')
      && /ctx\.fillText\("报价单价"/.test(appSrc));
    ck('BN', '服务端报告提示词同步用「报价单价」，不再出现「客户单价」',
      !aiSrc.includes('客户单价') && aiSrc.includes('price=报价单价')
      && aiSrc.includes('当前报价单价是否符合') && aiSrc.includes('」报价单价 ¥${r.price}'));
    ck('BN', '重复加价按清单/锚签名缓存，内部区提供主动重掷入口',
      /async function estAiPrice\(forceRefresh\)/.test(appSrc)
      && appSrc.includes('const sig = JSON.stringify({ appVer, payload });')
      && appSrc.includes('window.__APP_VERSION__')
      && appSrc.includes('_estUI.priceSig === sig')
      && appSrc.includes('onclick="estAiPrice(true)"') && appSrc.includes('🎲 换一组建议')
      && helpSrc.includes('重复点「重新加价」金额会跳吗')
      && cssSrc.includes('.cq-rate-actions'));
    ck('BN', '每次加价自动对比新旧金额：报价单渲染对比块、金额变化才重算',
      /function estQuoteCompare\(/.test(appSrc) && /function estCompareHtml\(/.test(appSrc)
      && quoteFn.includes('estCompareHtml(compare)') && quoteFn.includes('estQuoteCompare(prevCq, q)')
      && quoteFn.includes('compare,') && appSrc.includes('📊 与上次对比')
      && appSrc.includes('function estToggleCompareDetail()')
      && helpSrc.includes('每次加价自动对比新旧金额')
      && cssSrc.includes('.cq-compare') && cssSrc.includes('.cq-cmp-delta.is-up'));
    ck('BN', '对比数据不进三种导出，只挂在内存 cq.compare',
      !/cq\.compare|cq-cmp|estCompareHtml/.test(bnExportFn)
      && !/cq\.compare|cq-cmp|estCompareHtml/.test(bnTextSrc)
      && !/cq\.compare|cq-cmp|estCompareHtml/.test(appSrc.slice(appSrc.indexOf('function estCustomerQuoteImage('), appSrc.indexOf('function estCustomerQuoteExport('))));
    // 运行时：真实纯函数验证分项加价与起步价/辅材口径
    const cqCtx = { console };
    vm.createContext(cqCtx);
    vm.runInContext(calcSrc, cqCtx);
    const cqRows = [
      { n: '钢架焊接', u: '㎡', q: 12, fee: 360, cat: 'labor' },
      { n: '铝塑板', u: '㎡', q: 17.88, fee: 1698.6, cat: 'mat' },
      { n: '脚手架', u: '组', q: 4, fee: 192, cat: 'laborHigh' }
    ];
    const cqRates = { labor: 25, mat: 12, laborHigh: 35, equip: 28, transport: 15 };
    const cq = vm.runInContext('estCustomerQuoteCalc(' + JSON.stringify(cqRows) + ','
      + JSON.stringify(cqRates) + ',{floor:20,auxFee:30})', cqCtx);
    ck('BN', '分项加价：人工+25%、材料+12%、高风险+35%',
      cq.rows[0].amount === 450 && cq.rows[0].unit === 37.5
      && cq.rows[1].amount === 1902.43 && cq.rows[1].unit === 106.4
      && cq.rows[2].amount === 259.2);
    ck('BN', '起步价按人工率、辅材按材料率，合计同口径',
      cq.floor === 25 && cq.aux === 33.6 && cq.construction === 734.2
      && cq.material === 1936.03 && cq.grand === 2670.23);

    // 整单加价（成本加成）：内部成本 = 各行 fee + floor + auxFee = 2300.6
    const intCost = 360 + 1698.6 + 192 + 20 + 30;
    const flat = vm.runInContext('estCustomerQuoteCalc(' + JSON.stringify(cqRows) + ','
      + JSON.stringify(cqRates) + ',{floor:20,auxFee:30},null,30)', cqCtx);
    ck('BN', '整单 +30%：所有行统一率，起步价/辅材也按 30%',
      flat.rows.every((x) => x.rate === 30) && flat.floor === 26 && flat.aux === 39,
      JSON.stringify({ rate: flat.rows[0].rate, floor: flat.floor, aux: flat.aux }));
    ck('BN', '整单 +30%：合计精确 = 内部成本 ×(1+30%)，不漏算起步价/辅材',
      Math.abs(flat.grand - Math.round(intCost * 1.3 * 100) / 100) < 0.02,
      flat.grand + ' vs ' + Math.round(intCost * 1.3 * 100) / 100);
    const flat0 = vm.runInContext('estCustomerQuoteCalc(' + JSON.stringify(cqRows) + ','
      + JSON.stringify(cqRates) + ',{floor:20,auxFee:30},null,0)', cqCtx);
    ck('BN', '整单 0% 不被当成「未传率」回退默认（flat=0 生效）',
      flat0.rows.every((x) => x.rate === 0) && flat0.floor === 20 && flat0.aux === 30
      && flat0.grand === intCost, JSON.stringify(flat0.grand));
    ck('BN', '不传 flatRate 时仍走原分项加价（无回归）', cq.grand === 2670.23 && cq.rows[0].rate === 25);
    // 源码层：整单加价入口、成本加成、金额反推、状态贯穿、不碰金额链
    ck('BN', '整单加价 UI 与函数存在（成本加成 + 目标利润二选一）',
      appSrc.includes('function estApplyFlatMarkup()') && appSrc.includes('function estCustomerInternalCost()')
      && quoteFn.includes('id="cqFlatPct"') && quoteFn.includes('id="cqFlatAmt"')
      && quoteFn.includes('estApplyFlatMarkup()') && appSrc.includes('整单加价（成本加成'));
    ck('BN', '整单加价按内部成本反推利润金额，且夹到 0–300%',
      appSrc.includes('rate = Math.round(v / cost * 10000) / 100')
      && appSrc.includes('rate = Math.min(EST_PROFIT_MAX'));
    ck('BN', 'flatRate 存进 cq 并贯穿重绘，不写库不碰金额链',
      quoteFn.includes('flatRate: flat') && quoteFn.includes('useRates, flat)')
      && quoteFn.includes('if (flat != null) return flat')
      && !/cost_estimate|projectAmount|laborFee/.test(slice('function estApplyFlatMarkup()', 'async function estAiPrice')));
    ck('BN', 'CSS 有整单加价栏样式', cssSrc.includes('.cq-flat-row') && cssSrc.includes('.cq-flat-on'));
    ck('BN', '整单模式顶部明确标注非逐行 AI，不误导',
      quoteFn.includes('整单加价 ') && quoteFn.includes('非逐行 AI 建议')
      && quoteFn.includes('改下方任意单行的率即回到逐行模式'));
  }

  // ===== CD：重复加价稳定性（同签名沿用，主动重掷才重新请求 AI）=====
  {
    const priceParts = [
      'let _estUI = null;',
      slice('function estCostScope(', '/* 纯计算：内部成本行'),
      slice('function estCustomerQuoteRows()', 'function estAiPricePayload()'),
      slice('function estAiPricePayload()', 'function estOpenCustomerQuote('),
      slice('async function estAiPrice(forceRefresh)', 'function estAiQuoteCheckPayload()'),
    ].join('\n');
    const rc = {
      console,
      document: { getElementById: (id) => id === 'estInput' ? { value: '门头 6米×2米 发光字5个' } : null },
      estAiErrTip: (e, f) => f,
      toast: (m) => { rc.__toasts.push(m); },
      estOpenCustomerQuote: (data, fallback, rowRates, refPrices, applied) => {
        rc.__opens.push({ data, fallback, rowRates, refPrices });
        vm.runInContext('_estUI.customerQuote = { raw: ' + JSON.stringify(data)
          + ', src: ' + JSON.stringify(fallback ? 'local' : 'ai')
          + ', rowRates: ' + JSON.stringify(rowRates || null)
          + ', refPrices: ' + JSON.stringify(refPrices || null)
          + ', applied: ' + JSON.stringify(applied || []) + ' };', rc);
      },
      estAiInvoke: async (body) => {
        rc.__calls++; rc.__bodies.push(body);
        return { data: { ok: true, rates: [{ rate: 25 }, { rate: 12 }], summary: 'AI 加价' }, error: null };
      },
    };
    rc.__calls = 0; rc.__bodies = []; rc.__opens = []; rc.__toasts = [];
    vm.createContext(rc);
    vm.runInContext(priceParts, rc);
    vm.runInContext("_estUI = { work: [{ id: 'w1' }], height: 'low', wall: 'flat', result: { rows: [{ n: '钢架焊接', u: '㎡', q: 12, fee: 360, note: '' }, { n: '铝塑板', u: '㎡', q: 17.88, fee: 1698.6, note: '' }], floor: 0, auxFee: 0, labor: 360, matFee: 1698.6, equip: 0, transportFee: 0, grand: 2058.6, distanceKm: 0, roundTrip: false } };", rc);
    await rc.estAiPrice();
    ck('CD', '首次加价调用 AI 一次并记下签名',
      rc.__calls === 1 && !!vm.runInContext('_estUI.priceSig', rc)
      && rc.__opens.length === 1 && rc.__opens[0].fallback === false);
    await rc.estAiPrice();
    ck('CD', '清单/锚未变重复点重新加价不再请求 AI，沿用上次结果并提示',
      rc.__calls === 1 && rc.__opens.length === 2
      && JSON.stringify(rc.__opens[1].data) === JSON.stringify(rc.__opens[0].data)
      && /沿用当前利润率/.test(rc.__toasts[rc.__toasts.length - 1] || ''));
    await rc.estAiPrice(true);
    ck('CD', '「换一组建议」强制重掷 AI，旧缓存被新结果替换',
      rc.__calls === 2 && rc.__opens.length === 3
      && rc.__opens[2].data !== rc.__opens[1].data);
    vm.runInContext('_estUI.customerQuote.refPrices = [88, 0];', rc);
    await rc.estAiPrice();
    ck('CD', '成交价锚改动后自动重新请求 AI，锚进入 payload',
      rc.__calls === 3 && rc.__bodies[2].items[0].refPrice === 88);
    // C：加价成功后重绘报价单必须把本次实际使用的锚带回，否则 cq.refPrices 被清空 →
    // 下次签名变化 → 缓存永不命中 → 金额反复跳。
    ck('CD', '加价成功后重绘报价单带回成交价锚（不被清空）',
      Array.isArray(rc.__opens[rc.__opens.length - 1].refPrices)
      && rc.__opens[rc.__opens.length - 1].refPrices[0] === 88,
      JSON.stringify(rc.__opens[rc.__opens.length - 1].refPrices));
    ck('CD', '源码：成功/兜底重绘都传 prevRefs',
      /estOpenCustomerQuote\(data, false, null, prevRefs\)/.test(appSrc)
      && /estOpenCustomerQuote\(null, true, null, prevRefs\)/.test(appSrc));
  }

  // ===== CE：新旧加价金额对比（纯函数运行时验证）=====
  {
    const cmpSrc = slice('function estQuoteCompare(', 'function estOpenCustomerQuote(');
    const ceCtx = { console };
    vm.createContext(ceCtx);
    vm.runInContext(cmpSrc, ceCtx);
    const prev = { totals: { grand: 7953 }, rows: [
      { n: '钢架焊接', unit: 30, amount: 360 }, { n: '铝塑板', unit: 95, amount: 1698.6 }
    ] };
    const same = vm.runInContext('estQuoteCompare(' + JSON.stringify(prev) + ','
      + JSON.stringify({ grand: 7953, rows: prev.rows }) + ')', ceCtx);
    ck('CE', '金额没变时不生成对比（重绘/返回沿用上次）', same === null);
    const kept = { ...prev, compare: { oldGrand: 7000, newGrand: 7953, diff: 953, pct: 13.61, rows: [] } };
    const keptAgain = vm.runInContext('estQuoteCompare(' + JSON.stringify(kept) + ','
      + JSON.stringify({ grand: 7953, rows: prev.rows }) + ')', ceCtx);
    ck('CE', '金额没变时沿用上次对比对象，不丢历史',
      !!keptAgain && keptAgain.oldGrand === 7000 && keptAgain.newGrand === 7953);
    const changed = vm.runInContext('estQuoteCompare(' + JSON.stringify(prev) + ','
      + JSON.stringify({ grand: 8065.82, rows: [
        { n: '钢架焊接', unit: 37.5, amount: 450 }, { n: '铝塑板', unit: 95, amount: 1698.6 }
      ] }) + ')', ceCtx);
    ck('CE', '合计变化出差额与百分比，逐行只列变化项',
      changed && changed.oldGrand === 7953 && changed.newGrand === 8065.82
      && changed.diff === 112.82 && Math.abs(changed.pct - 1.42) < 0.02
      && changed.rows.length === 1 && changed.rows[0].n === '钢架焊接'
      && changed.rows[0].oldUnit === 30 && changed.rows[0].newUnit === 37.5
      && changed.rows[0].oldAmt === 360 && changed.rows[0].newAmt === 450);
    const added = vm.runInContext('estQuoteCompare(' + JSON.stringify(prev) + ','
      + JSON.stringify({ grand: 9053, rows: [
        { n: '钢架焊接', unit: 30, amount: 360 }, { n: '铝塑板', unit: 95, amount: 1698.6 },
        { n: '接线调试', unit: 250, amount: 1100 }
      ] }) + ')', ceCtx);
    ck('CE', '清单增加行时标注跨清单对比，新增行单独列',
      added && added.listChanged === true && added.rows.length === 1
      && added.rows[0].kind === 'add' && added.rows[0].n === '接线调试');
    // 渲染：HTML 转义 + 涨红跌绿 + 不导出字段
    const escFn = appSrc.slice(appSrc.indexOf('function esc(str)'), appSrc.indexOf('\n}', appSrc.indexOf('function esc(str)')) + 2);
    const htmlCtx = { console };
    vm.createContext(htmlCtx);
    vm.runInContext(escFn + '\n' + cmpSrc, htmlCtx);
    const html = vm.runInContext('estCompareHtml(' + JSON.stringify({ oldGrand: 7953, newGrand: 8065.82,
      diff: 112.82, pct: 1.42, listChanged: false,
      rows: [{ n: '<img src=x onerror=1>', oldUnit: 30, newUnit: 37.5, oldAmt: 360, newAmt: 450, kind: 'change' }] }) + ')', htmlCtx);
    ck('CE', '对比区块渲染合计/差额/逐行，恶意文本被转义，涨红跌绿',
      html.includes('📊 与上次对比') && html.includes('¥7,953.00') === false
      && html.includes('¥7953.00') && html.includes('¥8065.82')
      && html.includes('+¥112.82') && html.includes('+1.42%')
      && html.includes('cq-cmp-delta is-up') && html.includes('is-down') === false
      && html.includes('&lt;img src=x onerror=1&gt;') && !html.includes('<img src=x')
      && html.includes('不导出'));
    const downHtml = vm.runInContext('estCompareHtml(' + JSON.stringify({ oldGrand: 900, newGrand: 800,
      diff: -100, pct: -11.11, rows: [] }) + ')', htmlCtx);
    ck('CE', '金额下降显示跌绿与负号，无逐行变化时给提示',
      downHtml.includes('cq-cmp-delta is-down') && downHtml.includes('-¥100.00')
      && downHtml.includes('-11.11%') && downHtml.includes('各行单价未变'));
  }

  // ===== BO：客户报价单导出（图片 / 打印PDF / 文本）=====
  {
    const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const exportFn = slice('/* 客户报价单导出', '/* 重复拆解选择');
    const textSrc = slice('function estCustomerQuoteText(', 'function estCustomerQuotePrintHtml(');
    ck('BO', '报价单弹窗有导出入口，三种格式共用客户价数据',
      appSrc.includes('onclick="estOpenCustomerQuoteExport()"')
      && appSrc.includes('>⬇ 导出报价单</button>')
      && exportFn.includes('estCustomerQuoteText(')
      && exportFn.includes('estCustomerQuotePrintHtml(')
      && exportFn.includes('estCustomerQuoteImage(')
      && exportFn.includes('onClose: () =>'));
    ck('BO', '导出只读客户价字段，不取内部成本/加价率/依据',
      !/cq\.rates|cq\.raw|cq\.why|rates\[|why\[/.test(exportFn)
      && exportFn.includes('不含成本、利润率和加价依据')
      && !/cost_estimate|projectAmount|laborFee/.test(exportFn));
    ck('BO', '打印样式隐藏业务界面，只输出报价单内容',
      cssSrc.includes('body.cq-printing > *:not(#cqPrintRoot)') && cssSrc.includes('#cqPrintRoot')
      && cssSrc.includes('.cq-print-table') && cssSrc.includes('@media print'));
    ck('BO', '导出面板复用本机抬头/客户/单号，存本机不改云端',
      exportFn.includes('estCustomerQuoteExportInfo') && exportFn.includes('estimate_expinfo')
      && exportFn.includes('window.print()') && exportFn.includes('toDataURL("image/png")'));
    ck('BO', '说明书说明导出三种格式且不带成本',
      helpSrc.includes('生成图片 / 打印或存 PDF / 复制文本') && helpSrc.includes('绝不带出成本和加价依据'));
    const boCtx = { console };
    vm.createContext(boCtx);
    vm.runInContext('function estCustomerQuoteDate(){return "2026/11/25";}\n' + textSrc, boCtx);
    const sample = { rows: [{ n: '钢架焊接', u: '㎡', q: 12, unit: 37.5, amount: 450, cat: 'labor' }],
      totals: { construction: 475, material: 1936.03, grand: 2411.03 } };
    const txt = vm.runInContext('estCustomerQuoteText(' + JSON.stringify(sample)
      + ',{company:"XX广告",customer:"王总",no:"Q001"})', boCtx);
    ck('BO', '文本导出只列项目/报价单价/小计与合计，未带内部字段',
      txt.includes('客户报价单（不含税）') && txt.includes('客户：王总')
      && txt.includes('项目 | 数量 | 报价单价 | 小计') && !txt.includes('客户单价')
      && txt.includes('钢架焊接 | 12㎡ | ¥37.50 | ¥450.00')
      && txt.includes('合计：¥2411.03')
      && !/成本|利润率|加价|25%|12%/.test(txt));
  }

  // ===== BP：逐行利润率 / 参考成交价建议 / DeepSeek 备用 =====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const quoteFn = slice('function estOpenCustomerQuote(', 'async function estAiPrice(forceRefresh)');
    const calcSrc = slice('function estCustomerQuoteCalc(', 'function estCustomerQuoteRows()');
    ck('BP', '逐行 AI 率真正参与计算，不再被类别率抹平',
      appSrc.includes('const over = Array.isArray(rowRates) ? rowRates : null;')
      && /over && over\[i\] != null/.test(appSrc)
      && quoteFn.includes('estCustomerQuoteCalc(rows0, rates, r, useRates, flat)'));
    ck('BP', '客户报价单可逐行改利润率并填参考成交价',
      quoteFn.includes('data-cq-rate=') && quoteFn.includes('data-cq-ref=')
      && appSrc.includes('function estApplyCustomerQuoteRates()')
      && appSrc.includes('oninput="estMarkRateWarn(this,'));
    ck('BP', '报价复核携带参考价并展示逐项调价建议',
      appSrc.includes('refPrice: Number((cq.refPrices && cq.refPrices[i]) || 0) || 0')
      && appSrc.includes('data.priceAdvice') && appSrc.includes('cq-advice-item')
      && aiSrc.includes('refPrice: num(x?.refPrice)') && aiSrc.includes('priceAdvice'));
    ck('BP', 'DeepSeek 备用链路仍在（其他模式主模型失败才切）',
      aiSrc.includes('async function llmChat(') && aiSrc.includes('DEEPSEEK_API_KEY')
      && aiSrc.includes('DEEPSEEK_API_URL') && aiSrc.includes('DEEPSEEK_MODEL')
      && aiSrc.includes('if (!raw && backCfg)'));
    ck('BP', 'AI 偷懒给统一比例时逐行微调兜底',
      aiSrc.includes('内置逐行分层加价') && aiSrc.includes('const jitter = [0, 3, -2, 5, -4, 2, -3]'));
    ck('BP', '样式与说明书覆盖利润率编辑、参考价和备用模型',
      cssSrc.includes('.cq-rate-table') && cssSrc.includes('.cq-rate-warn') && cssSrc.includes('.cq-advice')
      && helpSrc.includes('利润率可以逐项自己改') && helpSrc.includes('DEEPSEEK_API_KEY'));
    const bpCtx = { console };
    vm.createContext(bpCtx);
    vm.runInContext(calcSrc, bpCtx);
    const bpRows = [
      { n: '钢架', u: '㎡', q: 12, fee: 360, cat: 'labor' },
      { n: '铝塑板', u: '㎡', q: 10, fee: 900, cat: 'mat' },
      { n: '高空接线', u: '组', q: 1, fee: 200, cat: 'laborHigh' }
    ];
    const bpRates = { labor: 25, mat: 12, laborHigh: 35, equip: 28, transport: 15 };
    const bpOut = vm.runInContext('estCustomerQuoteCalc(' + JSON.stringify(bpRows) + ','
      + JSON.stringify(bpRates) + ',{floor:0,auxFee:0},[31,7,48])', bpCtx);
    ck('BP', '逐行率覆盖类别率：31% / 7% / 48% 分别生效',
      bpOut.rows[0].rate === 31 && bpOut.rows[0].amount === 471.6
      && bpOut.rows[1].rate === 7 && bpOut.rows[1].amount === 963
      && bpOut.rows[2].rate === 48 && bpOut.rows[2].amount === 296
      && bpOut.grand === 1730.6);
  }

  // ===== BQ：DeepSeek 主审客户报价 + 一键应用改价方案 =====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const reportFn = slice('function estOpenQuoteReview(', '/* modal.open 是替换同一层弹窗');
    const applyFn = slice('function estPriceAdviceToRates(', 'async function estAiQuoteCheck()');
    ck('BQ', 'quotecheck 配了 DeepSeek 即以 DeepSeek 主审，其余模式仍智谱主备',
      aiSrc.includes('const deepFirst = mode === "quotecheck" && !!deepCfg;')
      && aiSrc.includes('const mainCfg = deepFirst ? deepCfg! : (apiKey ? glmCfg : deepCfg!);')
      && aiSrc.includes('const backCfg = deepFirst ? (apiKey ? glmCfg : null)'));
    ck('BQ', '只配 DeepSeek 密钥也能做报价复核，响应标记实际引擎',
      aiSrc.includes('if (!apiKey && !deepKey)')
      && aiSrc.includes('let engine = mainCfg === deepCfg ? "deepseek" : "glm";')
      && aiSrc.includes('webConfigured, industryCheck, industryCount: industryCheck.length, engine'));
    ck('BQ', '改价方案不再要求填参考价或联网，按加价率始终给方向',
      aiSrc.includes('即使没填参考价、没联网')
      && !aiSrc.includes('const hasRef = srcItems.some')
      && aiSrc.includes('pct 必须克制、有据'));
    ck('BQ', '报告标引擎并缓存方案，提供一键应用按钮',
      reportFn.includes('data.engine === "deepseek"') && reportFn.includes("复核引擎 ' + engineTxt")
      && reportFn.includes('cq.priceAdvice = advice')
      && reportFn.includes('onclick="estApplyPriceAdvice()"'));
    ck('BQ', '一键应用有纯函数与边界保护（越界/keep/0 跳过，0–300 截断）',
      applyFn.includes('function estPriceAdviceToRates(')
      && applyFn.includes('!Number.isInteger(i) || i < 0 || i >= rowCount || !pct')
      && applyFn.includes('Math.min(cap, Math.max(0, Math.round(nr * 10) / 10))')
      && applyFn.includes('estOpenCustomerQuote(cq.raw'));
    ck('BQ', '说明书说明 DeepSeek 主审与一键应用边界',
      helpSrc.includes('一键应用改价方案') && helpSrc.includes('优先用 DeepSeek 主审')
      && helpSrc.includes('不写工程金额'));
    const bqCtx = { console };
    vm.createContext(bqCtx);
    vm.runInContext(slice('function estPriceAdviceToRates(', 'function estApplyPriceAdvice()'), bqCtx);
    const bq = vm.runInContext('estPriceAdviceToRates([25,12,35],'
      + '[{i:0,pct:10},{i:1,pct:-20},{i:2,pct:0},{i:99,pct:50}],3)', bqCtx);
    ck('BQ', 'pct 折算正确：25%+10%→37.5%，12%-20%→0%，keep/越界跳过',
      bq.rates[0] === 37.5 && bq.rates[1] === 0 && bq.rates[2] === 35 && bq.changed === 2,
      JSON.stringify(bq));
    const bq2 = vm.runInContext('estPriceAdviceToRates([40],[{i:0,pct:30}],1)', bqCtx);
    ck('BQ', '调高按比例复合：40%+30% → 82%（不是简单相加 70%）', bq2.rates[0] === 82);
    const bq3 = vm.runInContext('estPriceAdviceToRates([90],[{i:0,pct:30}],1)', bqCtx);
    ck('BQ', '调高允许突破 100%：90%+30% 复合为 147%（成交价锚定场景）', bq3.rates[0] === 147);
  }

  // ===== BR：复核 loading / 联网文案不误导 / 已应用改价不再重复提示 =====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const checkFn = slice('let _estAiCheckBusy = false;', '/* 客户报价单导出');
    const applyFn = slice('function estApplyPriceAdvice()', 'async function estAiQuoteCheck()');
    ck('BR', '复核按钮有 id 与忙碌锁，点击后显示复核中并禁用',
      appSrc.includes('id="estAiCheckBtn"') && checkFn.includes('if (_estAiCheckBusy) return;')
      && checkFn.includes('btn.disabled = true') && checkFn.includes('复核中，请稍候')
      && checkFn.includes('b2.disabled = false') && checkFn.includes('finally'));
    ck('BR', '复核有可见进度条，文案说明主审与等待时长',
      appSrc.includes('id="estAiCheckTip"') && checkFn.includes('tip.style.display = "block"')
      && checkFn.includes('DeepSeek 主审') && checkFn.includes('60 秒'));
    ck('BR', '联网文案说明未配置/未取到结果/已取到三种状态，不再像故障提示',
      appSrc.includes('未配置联网行情源，按内置行业价与清单分析')
      && appSrc.includes('行情源已配但未取到结果')
      && appSrc.includes('内置行业价来自测算器 CATALOG')
      && !appSrc.includes('未联网，按清单与内置规则复核')
      && !appSrc.includes("'未取到联网行情'"));
    ck('BR', '一键应用记录已应用方向/幅度，复核 payload 带给服务端',
      applyFn.includes('cq.applied') && applyFn.includes('old.dir = a.dir')
      && applyFn.includes('estOpenCustomerQuote(cq.raw, cq.src === "local", out.rates, cq.refPrices, applied)')
      && appSrc.includes('applied: Array.isArray(cq.applied) ? cq.applied.slice(0, 12) : []'));
    ck('BR', '报告显示已应用项，且按调整后价格复核不再重复同方向建议',
      appSrc.includes('cq-applied-tip') && appSrc.includes('已应用 ')
      && appSrc.includes('本次复核基于调整后的价格'));
    ck('BR', '服务端白名单解析 applied 并在线索/提示词/输出三处跳过同方向',
      aiSrc.includes('function parseApplied(') && aiSrc.includes('quoteClues(text, items, totals, applied)')
      && aiSrc.includes('appliedResp.find((a) => a.i === i)')
      && aiSrc.includes('if (done && dir === done.dir) return null;')
      && aiSrc.includes('不要再给同方向建议'));
    ck('BR', '样式与说明书覆盖复核进度、已应用标记与未联网说明',
      cssSrc.includes('.est-ai-check-tip') && cssSrc.includes('.cq-applied-tip')
      && helpSrc.includes('按钮会变成') && helpSrc.includes('不是故障')
      && helpSrc.includes('不会再对同一行重复给同方向建议'));
    const brCtx = { console };
    vm.createContext(brCtx);
    vm.runInContext(slice('function estPriceAdviceToRates(', 'function estApplyPriceAdvice()'), brCtx);
    const br = vm.runInContext('estPriceAdviceToRates([45,30],'
      + '[{i:0,dir:"down",pct:-10},{i:1,dir:"up",pct:10}],2)', brCtx);
    ck('BR', '已应用方向折算仍正确：45%−10%→30.5%，30%+10%→43%',
      br.rates[0] === 30.5 && br.rates[1] === 43 && br.changed === 2, JSON.stringify(br));
  }

  // ===== BS：当地成交价作为定价锚，复核按锚定评价加价后的价格 =====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const cssSrc = fs.readFileSync(path.join(ROOT, 'styles.css'), 'utf8');
    const pricePayload = slice('function estAiPricePayload()', 'function estOpenCustomerQuote(');
    const reportFn = slice('function estOpenQuoteReview(', '/* modal.open 是替换同一层弹窗');
    const quoteFn = slice('function estOpenCustomerQuote(', 'async function estAiPrice(forceRefresh)');
    ck('BS', '有当地成交价时服务端允许突破类别上限（含 100%+），无锚定仍走护栏',
      aiSrc.includes('const ANCHOR_MAX_RATE = 200;')
      && aiSrc.includes('function clampProfitRate(cat: string, v: any, anchored = false, level: OpacityLevel = "low")')
      && aiSrc.includes('const hi = level === "low" ? g.max : rule.max;')
      && aiSrc.includes('clampProfitRate(cat, pick, true)'));
    ck('BS', '智能加价把当地成交价带入 payload，并按锚定反推逐行率/标依据',
      pricePayload.includes('refPrice: Number((cq && cq.refPrices && cq.refPrices[i]) || 0) || 0')
      && aiSrc.includes('refPrice: num(x?.refPrice),')
      && aiSrc.includes('basis: "refPrice"') && aiSrc.includes('anchorCount: anchorN')
      && aiSrc.includes('定价依据优先级：refPrice'));
    ck('BS', '报价复核服务端自算锚定评价，模型不吐目标金额且按成交价校正方向',
      aiSrc.includes('const anchors = srcItems.map(')
      && aiSrc.includes('const anchorMap = new Map(anchors.map(')
      && aiSrc.includes('priceAdviceTarget(srcItems[i], aiDir, aiPct, anchor)')
      && aiSrc.includes('成交价锚定：你填 ¥${anchor.refPrice}，当前价差 ${anchor.gapPct}%')
      && aiSrc.includes('priceAdvice, anchors, anchorCount: anchors.length'));
    ck('BS', '前端给出成交价锚定评价表与依据优先级，利润率最多 300%',
      reportFn.includes('const anchors = (data && Array.isArray(data.anchors))')
      && reportFn.includes('cq-anchor-table') && reportFn.includes('成交价锚定 ')
      && reportFn.includes('定价依据优先级')
      && appSrc.includes('const EST_PROFIT_MAX = 300;')
      && quoteFn.includes('max="300"')
      && appSrc.includes('Math.min(EST_PROFIT_MAX, Math.max(0, Math.round(v * 10) / 10))'));
    ck('BS', '样式与说明书覆盖成交价锚定、锚标记与 0–300% 上限',
      cssSrc.includes('.cq-anchor-table') && cssSrc.includes('.cq-basis')
      && helpSrc.includes('当地成交价（定价锚）') && helpSrc.includes('0–300%')
      && helpSrc.includes('按这个成交价反推该行利润率') && helpSrc.includes('当地成交价锚定评价'));
    const bsCtx = { console };
    vm.createContext(bsCtx);
    vm.runInContext(slice('function estPriceAdviceToRates(', 'function estApplyPriceAdvice()'), bsCtx);
    const bs = vm.runInContext('estPriceAdviceToRates([200],[{i:0,pct:30}],1)', bsCtx);
    ck('BS', '锚定场景 200%+30% 复合为 290%，未被 100% 截断', bs.rates[0] === 290, JSON.stringify(bs));
  }

  // ===== BT：不透明度决定利润空间，改价幅度放开到 200% 且守住成本线 =====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    const reportFn = slice('function estOpenQuoteReview(', '/* modal.open 是替换同一层弹窗');
    ck('BT', '服务端按不透明度分高/中/低三档，难比价项利润上限到 200%',
      aiSrc.includes('type OpacityLevel = "high" | "mid" | "low";')
      && aiSrc.includes('const OPAQUE_RATE: Record<OpacityLevel')
      && aiSrc.includes('high: { min: 35, def: 80, max: 200 }')
      && aiSrc.includes('const OPAQUE_MAX_UP: Record<OpacityLevel, number>')
      && aiSrc.includes('function quoteOpacity(x: any)')
      && /高空|吊篮|登高|离地|外墙|脚手架/.test(aiSrc)
      && /调试|接线|焊接|焊|拆除/.test(aiSrc));
    ck('BT', '改价幅度从 ±30 放开到 -50..200，报价与加价两处同步',
      aiSrc.includes('-50 到 200') && aiSrc.includes('Math.max(-50, Math.min(200, pv))')
      && !aiSrc.includes('-30 到 30') && !aiSrc.includes('Math.max(-30, Math.min(30, pv))')
      && aiSrc.includes('function priceAdviceTarget('));
    ck('BT', '服务端按成交价/不透明度/成本线校正，并返回依据与调后利润率',
      aiSrc.includes('basis: "refPrice"') && aiSrc.includes('basis = rateBasis')
      && aiSrc.includes('basis = "floor"') && aiSrc.includes('newRate }')
      && aiSrc.includes('再降将跌破成本线'));
    ck('BT', '报告显示依据标签与调后利润，说明书讲清 200% 与成本底线',
      reportFn.includes('cq-advice-basis') && reportFn.includes('调后利润 ')
      && reportFn.includes('不透明度/风险')
      && helpSrc.includes('利润空间看不透明度') && helpSrc.includes('+200%')
      && helpSrc.includes('不会把价格压到跌破成本'));
    const aiSlice = (a, b) => {
      const i = aiSrc.indexOf(a); if (i < 0) throw new Error('ai 切片起点未找到: ' + a);
      const j = aiSrc.indexOf(b, i); if (j < 0) throw new Error('ai 切片终点未找到: ' + b);
      return aiSrc.slice(i, j);
    };
    const stripTs = (s) => s
      .replace(/function quoteOpacity\(x: any\): \{[^}]+\} \{/, 'function quoteOpacity(x) {')
      .replace(/function priceAdviceTarget\([^)]*\):\s*\{[^}]+\} \{/, 'function priceAdviceTarget(x, aiDir, aiPct, anchor) {')
      .replace(/function unitCost\(x: any, key = "cost"\): number/, 'function unitCost(x, key = "cost")')
      .replace(/\(rate: number\)/g, '(rate)');
    const opFn = stripTs(aiSlice('function quoteOpacity(', '// 内置行业价参考库'));
    const targetFn = stripTs(aiSlice('function priceAdviceTarget(', '/** 统一的 OpenAI'));
    // unitCost 是模块级依赖，必须和 priceAdviceTarget 一起进沙箱（不能靠注入桩掩盖作用域问题）。
    const unitCostFn = stripTs(aiSlice('function unitCost(', '// 分项利润护栏'));
    const btCtx = {
      console,
      num: (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; },
      OPAQUE_RATE: { high: { min: 35, def: 80, max: 200 }, mid: { min: 20, def: 45, max: 100 }, low: { min: 8, def: 20, max: 45 } },
      OPAQUE_MAX_UP: { high: 200, mid: 100, low: 45 },
      PROFIT_GUARD: { labor: { min: 15, max: 35, def: 25 }, laborHigh: { min: 25, max: 50, def: 35 },
        mat: { min: 6, max: 20, def: 12 }, equip: { min: 15, max: 40, def: 28 }, transport: { min: 8, max: 25, def: 15 } },
    };
    vm.createContext(btCtx);
    vm.runInContext(unitCostFn + '\n' + opFn + '\n' + targetFn, btCtx);
    const bthi = vm.runInContext('quoteOpacity({n:"接线调试",cat:"labor",note:""})', btCtx);
    const btlow = vm.runInContext('quoteOpacity({n:"铝塑板",cat:"mat",note:""})', btCtx);
    ck('BT', '运行时：调试/接线判为难比价 high，铝塑板材料判为易比价 low',
      bthi.level === 'high' && btlow.level === 'low',
      JSON.stringify({ bthi, btlow }));
    const btUp = vm.runInContext('priceAdviceTarget({n:"接线调试",cat:"labor",cost:220,price:297},"down",-5,null)', btCtx);
    ck('BT', '运行时：难比价项当前 35% 利润，AI 建议降 5% 被纠正为调高约 33%',
      btUp.dir === 'up' && btUp.pct > 30 && btUp.pct < 40 && btUp.basis === 'opaque',
      JSON.stringify(btUp));
    const btFloor = vm.runInContext('priceAdviceTarget({n:"铝塑板",cat:"mat",cost:100,price:125},"down",-20,null)', btCtx);
    ck('BT', '运行时：会跌破成本线的降价被拦成 keep 并标保本依据',
      btFloor.dir === 'keep' && btFloor.pct === 0 && btFloor.basis === 'floor',
      JSON.stringify(btFloor));
  }

  console.log('\n=== BU. 行业价格对照：未联网也评价价格是否符合行业规则 ===');
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.existsSync(fnPath) ? fs.readFileSync(fnPath, 'utf8') : '';
    ck('BU', '服务端内置行业价库与只读校验，并随复核返回 webConfigured/industryCheck',
      aiSrc.includes('const INDUSTRY_PRICE: IndRule[] = [')
      && aiSrc.includes('function industryPriceCheck(items: any[]): any[]')
      && aiSrc.includes('industryCheck = industryPriceCheck(items)')
      && aiSrc.includes('webConfigured, industryCheck, industryCount: industryCheck.length'));
    ck('BU', '提示词要求从价格本身判断行业口径，并标注行业价/锚定/行情依据',
      aiSrc.includes('不要只评价 cost→price 的加价率')
      && aiSrc.includes('内置行业价对照')
      && aiSrc.includes('行业价参考：'));
    const reportFn = slice('function estOpenQuoteReview(', '/* modal.open 是替换同一层弹窗');
    ck('BU', '报告渲染客户报价口径的行业价格对照表与三种联网状态',
      reportFn.includes('cq-industry')
      && reportFn.includes('行业价格对照（客户报价口径，内部参考）')
      && reportFn.includes('未配置联网行情源，按内置行业价与清单分析')
      && reportFn.includes('行情源已配但未取到结果'));
    ck('BU', '说明书讲清不联网也判断行业规则、经验区间非当地实时成交价',
      helpSrc.includes('不联网也判断价格是否符合行业规则')
      && helpSrc.includes('经验区间不是当地实时成交价'));
    const aiSlice = (a, b) => {
      const i = aiSrc.indexOf(a); if (i < 0) throw new Error('ai 切片起点未找到: ' + a);
      const j = aiSrc.indexOf(b, i); if (j < 0) throw new Error('ai 切片终点未找到: ' + b);
      return aiSrc.slice(i, j);
    };
    const indSrc = aiSlice('type IndRule =', '// 有当地成交价锚定时');
    const stripInd = (s) => s
      .replace(/type IndRule = \{[^}]*\};/, '')
      .replace(/const INDUSTRY_PRICE: IndRule\[\] =/, 'const INDUSTRY_PRICE =')
      .replace(/const COST_SCOPE_LABEL: Record<string, string> =/, 'const COST_SCOPE_LABEL =')
      .replace(/function itemScope\(x: any, cat: string\): string/, 'function itemScope(x, cat)')
      .replace(/function normPriceUnit\(u: any\): string/, 'function normPriceUnit(u)')
      .replace(/function industryPriceCheck\(items: any\[\]\): any\[\]/, 'function industryPriceCheck(items)')
      .replace(/function industryCostFloor\([^)]*\): \{[^}]*\} \| null/, 'function industryCostFloor(x, cat)')
      .replace(/\(x: any, i: number\)/, '(x, i)')
      .replace(/const out: any\[\] = \[\];/g, 'const out = [];');
    const buCtx = { console, num: (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; } };
    vm.createContext(buCtx);
    vm.runInContext(stripInd(indSrc), buCtx);
    const buRows = vm.runInContext(`industryPriceCheck([
      { n: '发光字', u: '㎡', cat: 'mat', price: 597, note: '' },
      { n: '喷绘布画面', u: '㎡', cat: 'mat', price: 60, note: '' },
      { n: '接线调试', u: '组', cat: 'labor', price: 80, note: '' },
      { n: '桁架租赁', u: '米', cat: 'equip', price: 18, note: '' },
      { n: '铝塑板', u: '㎡', cat: 'mat', price: 105.36, note: '' },
      { n: '随便什么项', u: '㎡', cat: 'mat', price: 999, note: '' }
    ])`, buCtx);
    ck('BU', '运行时：发光字接近行业区间、喷绘布偏高、接线偏低、桁架租赁可匹配',
      buRows.length === 5 && buRows[0].verdict === '接近行业区间'
      && buRows[1].verdict === '高于行业区间'
      && buRows[2].verdict === '低于行业区间'
      && buRows[3].label === '桁架租赁'
      && buRows[4].label === '铝塑板板材进价' && buRows[4].verdict === '接近行业区间',
      JSON.stringify(buRows));
    const buUnknown = vm.runInContext(`industryPriceCheck([{ n: '随便什么项', u: '㎡', cat: 'mat', price: 123 }])`, buCtx);
    ck('BU', '运行时：匹配不到行业口径就不列，不编造行业价', buUnknown.length === 0);
  }

  console.log('\n=== BV. AI 失败提示读出 body.error，不再只显示笼统兜底 ===');
  {
    const errFn = slice('function estAiErrTip(', '/* 提示词优化：AI 补全尺寸');
    const bvCtx = {}; vm.createContext(bvCtx); vm.runInContext(errFn, bvCtx);
    const run = (expr) => vm.runInContext(expr, bvCtx);
    const fb = '"AI 报价复核失败，已保留你改好的单价（未应用改价建议）"';
    const r1 = run(`estAiErrTip(null, ${fb}, {error:"AI 未给出报价复核意见"})`);
    const r2 = run(`estAiErrTip(null, ${fb}, {error:"LLM_HTTP_401: bad key"})`);
    const r3 = run(`estAiErrTip({message:"timeout"}, ${fb}, null)`);
    const r4 = run(`estAiErrTip(null, ${fb}, {error:"某种未知原因"})`);
    ck('BV', 'HTTP 200 但 ok:false 时能翻译 data.error 的 EMPTY_QUOTE_REVIEW',
      r1.includes('没给出可用的复核意见'), r1);
    ck('BV', 'data.error 的密钥错误能翻成人话，超时提示不再重复失败前缀',
      /密钥无效|额度不足/.test(r2) && r3.includes('请求超时') && !r3.includes('复核失败'), r2 + ' | ' + r3);
    ck('BV', '未知原因把后端原文带出来，且明确「未应用改价建议」不再误读成「没改单价」',
      r4.includes('某种未知原因') && r4.includes('未应用改价建议'), r4);
    const r5 = run(`estAiErrTip(null, ${fb}, {error:"Failed to send a request to the Edge Function"})`);
    ck('BV', '网络层失败翻成人话，不再误判成函数未部署',
      r5.includes('连不上 AI 服务') && r5.includes('重试与原生直连两条通道都失败'), r5);
    ck('BV', 'fetch 网络层失败自动重试一次（只读 AI 请求，不写库不改金额）',
      /async function estAiInvoke\(body, timeoutMs = 16000, _retry = true\)/.test(appSrc)
      && appSrc.includes('return estAiInvoke(body, timeoutMs, false);')
      && /_retry && \/Failed to send a request to the Edge Function\|FunctionsFetchError/.test(appSrc));
    ck('BV', '两处 AI 复核都把 data 传给错误提示，catch 分支文案同口径',
      appSrc.includes('estAiErrTip(error, "AI 报价复核失败，已保留你改好的单价（未应用改价建议）", data)')
      && appSrc.includes('estAiErrTip(error, "AI 复核失败，已保留当前清单和金额（未应用建议）", data)')
      && appSrc.includes('catch (e) { toast("AI 报价复核失败，已保留你改好的单价（未应用改价建议）"); }'));
  }

  console.log('\n=== BW. 报价复核 DeepSeek 主审可观测：诊断/失败码/超时 ===');
  {
    const errFn = slice('function estAiErrTip(', '/* 提示词优化：AI 补全尺寸');
    const bwCtx = {}; vm.createContext(bwCtx); vm.runInContext(errFn, bwCtx);
    const run = (expr) => vm.runInContext(expr, bwCtx);
    const fb = '"AI 报价复核失败，已保留你改好的单价（未应用改价建议）"';
    // 后端 error 文案点名 DeepSeek 主备不可用，必须显示具体失败码，不再吞掉。
    const d1 = run(`estAiErrTip({message:"AI 主模型与备用模型均不可用（DeepSeek：DEEPSEEK_LLM_HTTP_402；智谱：GLM_LLM_HTTP_401）"}, ${fb}, null)`);
    ck('BW', 'DeepSeek 失败码不再误报成智谱密钥问题，显示 DeepSeek 主审失败',
      d1.includes('DeepSeek 主审失败') && !d1.includes('智谱密钥无效'), d1);
    // body.code 形态（HTTP 200 ok:false）也能识别 DeepSeek。
    const d2 = run(`estAiErrTip(null, ${fb}, {code:"DEEPSEEK_LLM_FAILED", error:"AI 主备均不可用"})`);
    ck('BW', 'data.code 里的 DEEPSEEK_ 前缀被识别，不落到通用 LLM_FAILED 分支',
      d2.includes('DeepSeek 主审失败'), d2);
    // engineDetail 判断：配了 DeepSeek 且只有智谱报错 → 明确报智谱兜底失败。
    const d3 = run(`estAiErrTip({message:"AI 主模型与备用模型均不可用", body:{error:"AI 主备均不可用", engineDetail:{deepseekConfigured:true,deepseekTried:true,deepseekErr:"",glmErr:"GLM_LLM_HTTP_401"}}}, ${fb}, null)`);
    ck('BW', 'engineDetail 能区分「DeepSeek 主审过但智谱兜底失败」',
      d3.includes('智谱兜底失败') && d3.includes('GLM_LLM_HTTP_401'), d3);
    ck('BW', 'estAiInvoke 透传后端完整 body（engineDetail 靠它出来）',
      appSrc.includes('e1.body = j;'));
    // 复核超时必须 >= 服务端主备最长耗时（DeepSeek 15×2 + 智谱 15×2）。
    const qcFn = slice('async function estAiQuoteCheck()', '/* 客户报价单导出');
    ck('BW', '报价复核超时提到 60 秒，匹配 DeepSeek 主审+智谱兜底最长耗时',
      qcFn.includes('estAiInvoke(body0, 60000)') && qcFn.includes('主备都失败最长约 60 秒'));
    // 报告引擎诊断：未配/主审成功/兜底 三态文案。
    ck('BW', '报告按 engineDetail 显示 DeepSeek 配置与主审状态，不再只写引擎名',
      appSrc.includes('未配置 DeepSeek')
      && appSrc.includes('DeepSeek 主审成功')
      && appSrc.includes('DeepSeek 主审失败')
      && appSrc.includes('cq-engine-note'));
    // 服务端：engineDetail 成功与失败两条返回路径都带，失败码加 DEEPSEEK_/GLM_ 前缀。
    const aiSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'estimate-ai', 'index.ts'), 'utf8');
    ck('BW', '服务端 engineDetail 含 deepseekConfigured/Tried/Err 与 finalEngine',
      aiSrc.includes('deepseekConfigured: !!deepCfg')
      && aiSrc.includes('deepseekTried: deepFirst')
      && aiSrc.includes('finalEngine: engine'));
    ck('BW', '服务端 DeepSeek 与智谱失败码分别加 DEEPSEEK_/GLM_ 前缀，不再混为一谈',
      aiSrc.includes('"DEEPSEEK_" + primary.code') || aiSrc.includes('(mainCfg === deepCfg ? "DEEPSEEK_" : "GLM_") + primary.code')
      && aiSrc.includes('"DEEPSEEK_" : "GLM_"'));
    ck('BW', '服务端失败响应 error 点名 DeepSeek、带 engineDetail；成功响应也带',
      aiSrc.includes('DeepSeek：${engineDetail.deepseekErr')
      && aiSrc.includes('code: errCode || "LLM_FAILED", engineDetail')
      && aiSrc.includes('industryCount: industryCheck.length, engine, engineDetail'),
      '失败文案片段/失败返回/成功返回三项');
  }

  console.log('\n=== BX. 报价复核双通道：原生 fetch 兜底 + 服务端提速 ===');
  {
    const aiSrc = fs.readFileSync(path.join(ROOT, 'supabase', 'functions', 'estimate-ai', 'index.ts'), 'utf8');
    // 服务端：LlmCfg 支持 per-call 超时，quotecheck 压缩到主审 9s / 兜底 11s，避开链路断连。
    ck('BX', 'LlmCfg 增加可选 timeoutMs，llmChat 用它替代固定 15s',
      aiSrc.includes('timeoutMs?: number;')
      && aiSrc.includes('setTimeout(() => ctrl.abort(), cfg.timeoutMs || 15000)'));
    ck('BX', 'quotecheck 压缩单次超时（deepseek 9s / glm 11s）',
      aiSrc.includes('if (mode === "quotecheck") {')
      && aiSrc.includes('glmCfg.timeoutMs = 11000;')
      && aiSrc.includes('deepCfg.timeoutMs = 9000;'));
    // 前端：原生 fetch 直连函数存在，且带 JWT + apikey + 超时 AbortController。
    ck('BX', '新增 estAiInvokeDirect 原生直连函数，带 Authorization/apikey/AbortController',
      appSrc.includes('async function estAiInvokeDirect(body, timeoutMs)')
      && appSrc.includes('/functions/v1/estimate-ai"')
      && appSrc.includes('"Authorization": "Bearer " + token')
      && appSrc.includes('"apikey": String(cfg.SUPABASE_ANON_KEY')
      && appSrc.includes('setTimeout(() => ctrl.abort(), timeoutMs)'));
    ck('BX', '直连复用多路径 token（_getSupabaseAccessToken），WebView/file 下也能取到登录态',
      appSrc.includes('const token = await _getSupabaseAccessToken();'));
    // 双通道策略：supabase-js 网络层失败先重试一次，再切原生直连；两通道原因都带出。
    ck('BX', '网络层失败重试一次后切原生直连，两通道失败原因合并透传',
      appSrc.includes('const direct = await estAiInvokeDirect(body, timeoutMs);')
      && appSrc.includes('if (!direct.error) return direct;')
      && appSrc.includes('"supabase-js：" + msg.slice(0, 50)')
      && appSrc.includes('"；直连：" + dmsg.slice(0, 80)'));
    ck('BX', '直连底层 cause（net::ERR/CORS）拼进错误，错误提示引导换 HTTPS 地址',
      appSrc.includes('"（直连底层：" + cause.slice(0, 80) + "）"')
      && appSrc.includes('原生直连两条通道都失败')
      && appSrc.includes('本地 file:// 的 Origin:null'));
  }

  console.log('\n=== BY. 顶层 num 作用域：quotecheck 不再 500（num is not defined） ===');
  {
    const fnPath = path.join(ROOT, 'supabase', 'functions', 'estimate-ai', 'index.ts');
    const aiSrc = fs.readFileSync(fnPath, 'utf8');
    // 1) num 必须定义在模块顶层（Deno.serve 之前），不能在 handler 内部；否则顶层函数访问不到。
    const serveAt = aiSrc.indexOf('Deno.serve(');
    const numAt = aiSrc.indexOf('function num(');
    ck('BY', 'num 提升为模块级函数，定义在 Deno.serve 之前（不再藏在 handler 内部）',
      numAt >= 0 && serveAt > numAt
      && !/const num = \(v: any\) =>/.test(aiSrc),
      JSON.stringify({ numAt, serveAt }));
    ck('BY', '说明书记录 num is not defined 导致 500 的排查方法（看 Logs + 重新部署）',
      helpSrc.includes('num is not defined')
      && helpSrc.includes('用量却不增长')
      && helpSrc.includes('supabase functions deploy estimate-ai'));
    // 2) 关键回归：不注入 num 桩，直接从源码切出 num 定义 + 顶层函数在同一作用域运行。
    //    旧版 num 藏在 handler 里，这里会抛 ReferenceError: num is not defined（正是线上 500 的原因）。
    const aiSlice = (a, b) => {
      const i = aiSrc.indexOf(a); if (i < 0) throw new Error('ai 切片起点未找到: ' + a);
      const j = aiSrc.indexOf(b, i); if (j < 0) throw new Error('ai 切片终点未找到: ' + b);
      return aiSrc.slice(i, j);
    };
    const numDef = aiSlice('function num(', '// 分项利润护栏')
      .replace('function num(v: any): number', 'function num(v)')
      .replace('function unitCost(x: any, key = "cost"): number', 'function unitCost(x, key = "cost")');
    const stripTs = (s) => s
      .replace(/const COST_SCOPE_LABEL: Record<string, string> =/, 'const COST_SCOPE_LABEL =')
      .replace(/function itemScope\(x: any, cat: string\): string/, 'function itemScope(x, cat)')
      .replace(/function industryPriceCheck\(items: any\[\]\): any\[\]/, 'function industryPriceCheck(items)')
      .replace(/function industryCostFloor\([^)]*\): \{[^}]*\} \| null/, 'function industryCostFloor(x, cat)')
      .replace(/\(x: any, i: number\)/, '(x, i)')
      .replace(/const out: any\[\] = \[\];/g, 'const out = [];');
    const indSrc = stripTs(aiSlice('type IndRule =', '// 有当地成交价锚定时'))
      .replace(/type IndRule = \{[^}]*\};/, '')
      .replace(/const INDUSTRY_PRICE: IndRule\[\] =/, 'const INDUSTRY_PRICE =')
      .replace(/function normPriceUnit\(u: any\): string/, 'function normPriceUnit(u)');
    const byCtx = { console }; // 故意不提供 num 桩
    vm.createContext(byCtx);
    let threw = null;
    try {
      vm.runInContext(numDef + '\n' + indSrc, byCtx);
    } catch (e) { threw = String(e && e.message || e); }
    ck('BY', '无 num 桩时加载 num + 行业价校验不抛 ReferenceError',
      threw === null, String(threw));
    if (!threw) {
      const rows = vm.runInContext(`industryPriceCheck([
        { n: '发光字', u: '㎡', cat: 'mat', price: 597, note: '' },
        { n: '接线调试', u: '组', cat: 'labor', price: 80, note: '' }
      ])`, byCtx);
      ck('BY', '运行时：不注入桩也能正确算行业价对照（复用模块级 num）',
        rows.length === 2 && rows[0].verdict === '接近行业区间' && rows[1].verdict === '低于行业区间',
        JSON.stringify(rows));
      // priceAdviceTarget 同样依赖 num，确认它在无桩作用域也能调用。
      const opConsts = `const OPAQUE_RATE={high:{min:35,def:80,max:200},mid:{min:20,def:45,max:100},low:{min:8,def:20,max:45}};const OPAQUE_MAX_UP={high:200,mid:100,low:45};`;
      const opFn = aiSlice('function quoteOpacity(', '// 内置行业价参考库')
        .replace(/function quoteOpacity\(x: any\): \{[^}]*\} \{/, 'function quoteOpacity(x) {');
      const targetFn = aiSlice('function priceAdviceTarget(', '/** 统一的 OpenAI')
        .replace(/function priceAdviceTarget\([^)]*\):\s*\{[^}]+\} \{/, 'function priceAdviceTarget(x, aiDir, aiPct, anchor) {')
        .replace(/\(rate: number\)/g, '(rate)');
    const unitCostFn = aiSlice('function unitCost(', '// 分项利润护栏')
      .replace(/function unitCost\(x: any, key = "cost"\): number/, 'function unitCost(x, key = "cost")');
    const guardConsts = `const PROFIT_GUARD={labor:{min:15,max:35,def:25},laborHigh:{min:25,max:50,def:35},mat:{min:6,max:20,def:12},equip:{min:15,max:40,def:28},transport:{min:8,max:25,def:15}};`;
      vm.runInContext(guardConsts + '\n' + unitCostFn + '\n' + opConsts + '\n' + opFn + '\n' + targetFn, byCtx);
      const t = vm.runInContext(`priceAdviceTarget({n:"接线调试",cat:"labor",cost:220,price:297},"down",-5,null)`, byCtx);
      ck('BY', '运行时：priceAdviceTarget 无 num 桩也能调用并纠正难比价项',
        t && t.dir === 'up' && t.pct > 30, JSON.stringify(t));
    }
  }

  console.log('\n=== BZ. 成本量纲：整行总费用不得当单价，消除 -97% 假亏损与 +45% 乱加价 ===');
  {
    const fnPath = path.join(ROOT, 'supabase', 'functions', 'estimate-ai', 'index.ts');
    const aiSrc = fs.readFileSync(fnPath, 'utf8');
    ck('BZ', 'unitCost 按 q 折算单价，且所有利润率计算点统一调用（含发给 AI 的 items）',
      aiSrc.includes('function unitCost(x: any, key = "cost"): number')
      && (aiSrc.match(/unitCost\(x\)/g) || []).length >= 3
      && aiSrc.includes('cost: unitCost(x), costTotal')
      && aiSrc.includes('const fee = unitCost(x, "fee"), refPrice = num(x?.refPrice)')
      && aiSrc.includes('const cost = unitCost(srcItems[i]), price = num(srcItems[i]?.price)')
      && !/const cost = num\(x\?\.cost\), price = num\(x\?\.price\)/.test(aiSrc));
    ck('BZ', '提示词禁止拿 costTotal 算利润率，用户消息写明 cost 是单位成本',
      aiSrc.includes('严禁拿它和单价相比') && aiSrc.includes('cost=【单位成本，已按 q 折算'));
    ck('BZ', '说明书讲清假亏损 bug 的成因与「重新加价」恢复方法',
      helpSrc.includes('整行成本总额') && helpSrc.includes('单位成本')
      && helpSrc.includes('重新加价') && helpSrc.includes('高于/低于行业区间'));
    ck('BZ', '易比价材料 basis=guard 与理由一致，前端有「类别区间」标签映射',
      aiSrc.includes('const rateBasis = op.level === "low" ? "guard" : "opaque"')
      && appSrc.includes('a.basis === "guard" ? "类别区间"'));
    // 运行时：用截图真实数字复现。热镀锌方管 52米 总价¥1040、报价单价¥22.40。
    const aiSlice = (a, b) => {
      const i = aiSrc.indexOf(a); if (i < 0) throw new Error('ai 切片起点未找到: ' + a);
      const j = aiSrc.indexOf(b, i); if (j < 0) throw new Error('ai 切片终点未找到: ' + b);
      return aiSrc.slice(i, j);
    };
    const numDef = aiSlice('function num(', '// 分项利润护栏')
      .replace('function num(v: any): number', 'function num(v)')
      .replace('function unitCost(x: any, key = "cost"): number', 'function unitCost(x, key = "cost")');
    const stripTs = (s) => s
      .replace(/function quoteOpacity\(x: any\): \{[^}]+\} \{/, 'function quoteOpacity(x) {')
      .replace(/function priceAdviceTarget\([^)]*\):\s*\{[^}]+\} \{/, 'function priceAdviceTarget(x, aiDir, aiPct, anchor) {')
      .replace(/\(rate: number\)/g, '(rate)');
    const opFn = stripTs(aiSlice('function quoteOpacity(', '// 内置行业价参考库'));
    const targetFn = stripTs(aiSlice('function priceAdviceTarget(', '/** 统一的 OpenAI'));
    const bzCtx = {
      console,
      OPAQUE_RATE: { high: { min: 35, def: 80, max: 200 }, mid: { min: 20, def: 45, max: 100 }, low: { min: 8, def: 20, max: 45 } },
      OPAQUE_MAX_UP: { high: 200, mid: 100, low: 45 },
      PROFIT_GUARD: { labor: { min: 15, max: 35, def: 25 }, laborHigh: { min: 25, max: 50, def: 35 },
        mat: { min: 6, max: 20, def: 12 }, equip: { min: 15, max: 40, def: 28 }, transport: { min: 8, max: 25, def: 15 } },
    };
    vm.createContext(bzCtx);
    vm.runInContext(numDef + '\n' + opFn + '\n' + targetFn, bzCtx);
    // 截图行：热镀锌方管 52米 成本¥1040 单价¥22.4 → 单位成本¥20、当前利润 12%（正常区间）。
    const bzTube = vm.runInContext(`unitCost({q:52,cost:1040})`, bzCtx);
    ck('BZ', '运行时：热镀锌方管 ¥1040/52米 归一为单价 ¥20，不再是 ¥1040', bzTube === 20, String(bzTube));
    const bzAdvice = vm.runInContext(
      `priceAdviceTarget({n:"热镀锌方管",cat:"mat",q:52,cost:1040,price:22.4,note:""},"up",45,null)`, bzCtx);
    ck('BZ', '运行时：该行按单价算 12% 利润属正常区间，不再触发 +45% 乱加价，依据标类别区间',
      bzAdvice.pct < 12 && bzAdvice.basis === 'guard', JSON.stringify(bzAdvice));
    const bzNewRate = vm.runInContext(`(() => { const cost=unitCost({q:52,cost:1040}), price=22.4, pct=0;
      return Math.round((price*(1+pct/100)-cost)/cost*1000)/10; })()`, bzCtx);
    ck('BZ', '运行时：调后利润率按单价算是 +12%，不再是截图里的 -96.9%', bzNewRate === 12, String(bzNewRate));
    // 铝塑板 17.88㎡ 成本¥1698.6、单价¥104.5 → 单位成本¥95、利润约10%。
    const bzAlu = vm.runInContext(`unitCost({q:17.88,cost:1698.6})`, bzCtx);
    ck('BZ', '运行时：铝塑板 ¥1698.6/17.88㎡ 归一为单价 ¥95，利润回到 +10% 正常区间',
      bzAlu === 95, String(bzAlu));
    // 行业价评价收紧：钢架 ¥264 超上限 250 约 5.6%，应判高于而非接近。
    const indSrc = stripTs(aiSlice('type IndRule =', '// 有当地成交价锚定时'))
      .replace(/type IndRule = \{[^}]*\};/, '')
      .replace(/const INDUSTRY_PRICE: IndRule\[\] =/, 'const INDUSTRY_PRICE =')
      .replace(/const COST_SCOPE_LABEL: Record<string, string> =/, 'const COST_SCOPE_LABEL =')
      .replace(/function itemScope\(x: any, cat: string\): string/, 'function itemScope(x, cat)')
      .replace(/function normPriceUnit\(u: any\): string/, 'function normPriceUnit(u)')
      .replace(/function industryPriceCheck\(items: any\[\]\): any\[\]/, 'function industryPriceCheck(items)')
      .replace(/function industryCostFloor\([^)]*\): \{[^}]*\} \| null/, 'function industryCostFloor(x, cat)')
      .replace(/\(x: any, i: number\)/, '(x, i)')
      .replace(/const out: any\[\] = \[\];/g, 'const out = [];');
    const bzIndCtx = { console };
    vm.createContext(bzIndCtx);
    vm.runInContext(numDef + '\n' + indSrc, bzIndCtx);
    const bzInd = vm.runInContext(`industryPriceCheck([{n:"门头钢架焊接/加固",u:"㎡",cat:"mat",price:264,note:""}])`, bzIndCtx);
    ck('BZ', '运行时：钢架 ¥264 超行业上限 ¥250，判「高于行业区间」不再笼统说接近',
      bzInd.length === 1 && bzInd[0].verdict === '高于行业区间', JSON.stringify(bzInd));
  }

  console.log('\n=== CA. 联网行情源：国内博查 bocha 可配置、可解析 ===');
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.readFileSync(fnPath, 'utf8');
    ck('CA', '三种搜索源共用一个配置判定，webConfigured 与真实请求同口径',
      aiSrc.includes('const SEARCH_PROVIDERS = ["tavily", "serper", "bocha"]')
      && aiSrc.includes('function searchConfigured(): boolean')
      && aiSrc.includes('webConfigured = searchConfigured()')
      && aiSrc.includes('api.bochaai.com/v1/web-search'));
    ck('CA', '说明书推荐 bocha 并给出 secrets set + deploy 命令',
      helpSrc.includes('REVIEW_SEARCH_PROVIDER')
      && helpSrc.includes('bocha')
      && helpSrc.includes('supabase secrets set REVIEW_SEARCH_PROVIDER=bocha')
      && helpSrc.includes('supabase functions deploy estimate-ai'));
    const aiSlice = (a, b) => {
      const i = aiSrc.indexOf(a); if (i < 0) throw new Error('ai 切片起点未找到: ' + a);
      const j = aiSrc.indexOf(b, i); if (j < 0) throw new Error('ai 切片终点未找到: ' + b);
      return aiSrc.slice(i, j);
    };
    const webSrc = aiSlice('const SEARCH_PROVIDERS =', '// review 模式：')
      .replace('function searchConfigured(): boolean', 'function searchConfigured()')
      .replace('async function reviewWebRefs(text: string, items: any[]): Promise<string[]>', 'async function reviewWebRefs(text, items)')
      .replace(/const queries: string\[\] = \[\];/, 'const queries = [];')
      .replace(/const refs: string\[\] = \[\];/, 'const refs = [];')
      .replace(/let rows: any\[\] = \[\];/g, 'let rows = [];')
      .replace(/\(r: any\)/g, '(r)');
    const calls = [];
    const env = { REVIEW_SEARCH_PROVIDER: 'bocha', REVIEW_SEARCH_KEY: 'bk_test' };
    const caCtx = {
      console, setTimeout, clearTimeout, AbortController, URL,
      Deno: { env: { get: (k) => env[k] || '' } },
      fetch: async (url, opt) => {
        calls.push({ url, opt });
        return { ok: true, json: async () => ({ data: { webPages: { value: [
          { name: '门头安装人工费行情', url: 'https://example.com/price', snippet: '当地门头安装 120-250 元/平方米' },
        ] } } }) };
      },
    };
    vm.createContext(caCtx);
    vm.runInContext(webSrc, caCtx);
    const refs = await vm.runInContext('reviewWebRefs("门头招牌", [])', caCtx);
    const sent = calls[0] ? JSON.parse(calls[0].opt.body) : {};
    ck('CA', '运行时：bocha 走国内接口并解析 data.webPages.value，报告拿到行情摘要',
      calls.length === 1 && calls[0].url === 'https://api.bochaai.com/v1/web-search'
      && calls[0].opt.headers.Authorization === 'Bearer bk_test'
      && sent.count === 3 && sent.freshness === 'oneYear'
      && refs.length === 1 && refs[0].includes('example.com') && refs[0].includes('120-250'),
      JSON.stringify({ calls: calls.map((c) => ({ url: c.url, headers: c.opt.headers, body: sent })), refs }));
    env.REVIEW_SEARCH_PROVIDER = 'unknown';
    const refs2 = await vm.runInContext('reviewWebRefs("门头", [])', caCtx);
    ck('CA', '运行时：未知 provider 不发请求、不假称联网',
      calls.length === 1 && refs2.length === 0, JSON.stringify(refs2));
  }

  console.log('\n=== CB. 成本复核按费用口径拆分：纯施工费 / 材料 / 含料 ===');
  {
    const aiSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/estimate-ai/index.ts'), 'utf8');
    ck('CB', '前端给每条测算行打费用口径标签，含料只在写明时才认',
      appSrc.includes('function estCostScope(x)') && appSrc.includes('if (x && x.isMat) return "material";')
      && appSrc.includes('/包工包料|成品|含材料|全包/.test(s)') && appSrc.includes('scope: estCostScope(x)'));
    {
      const scopeFn = slice('function estCostScope(', 'function estItemCat(');
      const ctx = { console };
      vm.createContext(ctx);
      vm.runInContext(scopeFn, ctx);
      const got = vm.runInContext(`[
        estCostScope({n:'门头钢架焊接/加固',note:'标准 1.1 工时/㎡ · 焊工 60元/时',hours:9.6,fee:345.6}),
        estCostScope({n:'热镀锌方管(骨架)',isMat:true}),
        estCostScope({n:'门头钢架',note:'包工包料',fee:1800}),
        estCostScope({n:'桁架租赁',isEquip:true})
      ]`, ctx);
      ck('CB', '运行时：焊接人工=纯施工费、方管=材料、包工包料=含料、租赁=设备',
        JSON.stringify(got) === JSON.stringify(['labor', 'material', 'combined', 'equip']), JSON.stringify(got));
    }
    ck('CB', '行业库仍保留同口径比对（仅客户报价复核使用）',
      aiSrc.includes('const COST_SCOPE_LABEL') && aiSrc.includes('r.scopes.indexOf(scope) >= 0')
      && aiSrc.includes('scopeLabel: COST_SCOPE_LABEL[scope]')
      && aiSrc.includes('industryCheck = industryPriceCheck(items)'));
    {
      const aiSlice = (a, b) => {
        const i = aiSrc.indexOf(a); if (i < 0) throw new Error('ai 切片起点未找到: ' + a);
        const j = aiSrc.indexOf(b, i); if (j < 0) throw new Error('ai 切片终点未找到: ' + b);
        return aiSrc.slice(i, j);
      };
      const indSrc = aiSlice('type IndRule =', '// 有当地成交价锚定时')
        .replace(/type IndRule = \{[^}]*\};/, '')
        .replace(/const INDUSTRY_PRICE: IndRule\[\] =/, 'const INDUSTRY_PRICE =')
        .replace(/const COST_SCOPE_LABEL: Record<string, string> =/, 'const COST_SCOPE_LABEL =')
        .replace(/function itemScope\(x: any, cat: string\): string/, 'function itemScope(x, cat)')
        .replace(/function normPriceUnit\(u: any\): string/, 'function normPriceUnit(u)')
        .replace(/function industryPriceCheck\(items: any\[\]\): any\[\]/, 'function industryPriceCheck(items)')
        .replace(/function industryCostFloor\([^)]*\): \{[^}]*\} \| null/, 'function industryCostFloor(x, cat)')
        .replace(/\(x: any, i: number\)/, '(x, i)')
        .replace(/const out: any\[\] = \[\];/g, 'const out = [];');
      const ctx = { console, num: (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; } };
      vm.createContext(ctx);
      vm.runInContext(indSrc, ctx);
      const rows = vm.runInContext(`industryPriceCheck([
        { n:'门头钢架焊接/加固', u:'㎡', q:12, fee:792, cat:'labor', scope:'labor', note:'焊工60元/时' },
        { n:'门头面板/铝塑板安装', u:'㎡', q:12, fee:403.2, cat:'labor', scope:'labor', note:'裁切打胶' },
        { n:'热镀锌方管(骨架)', u:'㎡', q:12, fee:1800, cat:'mat', scope:'material', note:'' },
        { n:'门头钢架', u:'㎡', q:12, fee:3168, cat:'mat', scope:'material', note:'含料' },
        { n:'铝塑板', u:'㎡', q:12, fee:1140, cat:'mat', scope:'material', note:'' }
      ].map(x => ({ ...x, price: x.fee / x.q })))`, ctx);
      ck('CB', '运行时：¥66/㎡ 纯焊接人工只比人工区间，不再误判低于含料钢架 ¥120–250',
        rows[0] && rows[0].label === '钢架焊接人工' && rows[0].verdict === '接近行业区间'
        && rows[0].scope === 'labor' && rows[0].scopeLabel === '纯施工费', JSON.stringify(rows[0]));
      ck('CB', '运行时：¥33.6/㎡ 面板安装按纯安装人工区间，不再套 60–120 含辅材区间',
        rows[1] && rows[1].label === '门头面板安装人工' && rows[1].verdict === '接近行业区间', JSON.stringify(rows[1]));
      ck('CB', '运行时：含料钢架 ¥240/㎡ 仍按含料区间判接近，材料 ¥150/㎡ 不套成品区间',
        rows[2] && rows[2].label === '钢架材料/成品（含料）' && rows[2].verdict === '接近行业区间'
        && rows[3] && rows[3].label === '钢架材料/成品（含料）' && rows[3].verdict === '高于行业区间'
        && rows[4] && rows[4].label === '铝塑板板材进价' && rows[4].verdict === '接近行业区间', JSON.stringify(rows));
      const legacy = vm.runInContext(`industryPriceCheck([{ n:'门头钢架焊接/加固', u:'㎡', cat:'labor', price:66 }])`, ctx);
      ck('CB', '运行时：老客户端不传 scope 时按 cat 兜底为纯施工费',
        legacy.length === 1 && legacy[0].scope === 'labor' && legacy[0].verdict === '接近行业区间', JSON.stringify(legacy));
    }
  }

  // ===== CC：方案复核运行时——内置核对按拆解/组合分组、不再给价格结论 =====
  {
    const aiSrc = fs.readFileSync(path.join(ROOT, 'supabase/functions/estimate-ai/index.ts'), 'utf8');
    const clueSrc = aiSrc.slice(aiSrc.indexOf('function reviewClues('), aiSrc.indexOf('const SEARCH_PROVIDERS'))
      .replace(/function reviewClues\([^)]*\): string\[\]/, 'function reviewClues(text, items, totals, cond, params)')
      .replace(/const out: string\[\] = \[\];/, 'const out = [];')
      .replace(/const push([DC]) = \(s: string\) =>/g, 'const push$1 = (s) =>')
      .replace(/const hasItem = \(re: RegExp\)/, 'const hasItem = (re)')
      .replace(/const toM = \(v: any, u: any\)/, 'const toM = (v, u)')
      .replace(/const short = \(s: any\)/, 'const short = (s)')
      .replace(/const seen: Record<string, boolean> = \{\};/, 'const seen = {};')
      .replace(/const units: Record<string, string> = \{\};/, 'const units = {};');
    const ctx = { console };
    vm.createContext(ctx);
    vm.runInContext(clueSrc, ctx);
    const clues = vm.runInContext(`reviewClues(
      '门头 6米×2米 离地4米 发光字 桁架4.6×3米 喷绘布',
      [{n:'钢架焊接/加固',u:'㎡',q:12,h:9.6,fee:345.6,note:'焊工60元/时'},
       {n:'喷绘布',u:'㎡',q:20,fee:240,note:'画面'},
       {n:'灯箱布',u:'㎡',q:20,fee:600,note:'内打光'}],
      {transportFee:0}, {height:'high',distanceKm:0},
      {rateNormal:36,rateHigh:75,rateAz:48,rateJz:60})`, ctx);
    ck('CC', '运行时：内置核对同时给出拆解与组合两组线索',
      clues.some((c) => c.indexOf('【拆解】') === 0) && clues.some((c) => c.indexOf('【组合】') === 0),
      JSON.stringify(clues));
    ck('CC', '运行时：喷绘布+灯箱布被判组合重复，高空有对应措施提示',
      clues.some((c) => c.includes('喷绘布与内打光灯箱布'))
      && clues.some((c) => c.includes('登高') || c.includes('施工条件为高空')),
      JSON.stringify(clues));
    ck('CC', '运行时：¥28.8/㎡ 纯焊工只查结构口径，不再输出行业成本高低结论',
      !clues.some((c) => /行业区间|成本偏高|成本偏低|利润/.test(c)), JSON.stringify(clues));
    // 带单位尺寸（6米×2米 / 5个60厘米）不再误报「尺寸缺失」——用户原文已给全尺寸
    const cluesDim = vm.runInContext(`reviewClues(
      '门头 6米×2米，发光字5个60厘米',
      [{n:'发光字安装（按㎡）',u:'㎡',q:1.8,fee:138.24,note:'5个字 宽0.6米=1.8㎡'},
       {n:'热镀锌方管（骨架）',u:'米',q:52,fee:1040,note:'6米/根 9根'},
       {n:'铝塑板',u:'㎡',q:17.88,fee:1698.6,note:'净用16.72㎡'},
       {n:'LED灯条',u:'米',q:24,fee:288},
       {n:'LED电源',u:'个',q:1,fee:90},
       {n:'电线/线缆',u:'米',q:21,fee:126}],
      {transportFee:240}, {height:'low',distanceKm:30},
      {rateNormal:36,rateHigh:75,rateAz:48,rateJz:60})`, ctx);
    ck('CC', '运行时：6米×2米 带单位尺寸不再报「没给宽高或面积」',
      !cluesDim.some((c) => /没给宽高或面积|尺寸缺失|未提供门头尺寸/.test(c)), JSON.stringify(cluesDim));
    ck('CC', '运行时：字数折面积不算「面积与原文不符」',
      !cluesDim.some((c) => /面积与原文不符|面积.*需核对/.test(c)), JSON.stringify(cluesDim));
    const clueDim3 = vm.runInContext(`reviewClues('挖坑 3米×2米×1.5米', [], {}, {height:'low',distanceKm:0}, {})`, ctx);
    ck('CC', '运行时：三维带单位尺寸不再报「未写三维尺寸」',
      !clueDim3.some((c) => /未写三维尺寸/.test(c)), JSON.stringify(clueDim3));
    ck('CC', '提示词：AI 不得照抄内置误报尺寸缺失、字数折面积不算不符、改问厚度/高度口径',
      aiSrc.includes('【尺寸口径铁律】') && aiSrc.includes('【字数折面积不是"不符"】')
      && aiSrc.includes('【该问的是什么】') && aiSrc.includes('绝不能报「尺寸缺失」')
      && aiSrc.includes('门头/板材厚度') && aiSrc.includes('是否包含 LOGO 与小字'));
    // A：取消「至少3条」逼AI凑数的机制，改为宁缺毋滥 + 依据必须点名具体行
    ck('CC', '提示词：不再强制3条、禁尺寸/数量核对套话、依据须点名具体行',
      aiSrc.includes('输出 1–5 条 suggestions') && aiSrc.includes('宁缺毋滥')
      && aiSrc.includes('严禁为凑数编造') && aiSrc.includes('无指向套话')
      && aiSrc.includes('点名具体行或具体字段')
      && aiSrc.includes('少于 3 条完全正常') && aiSrc.includes('不足 3 条不要硬凑'));
    // B：用户关心的三项做成内置确定性规则，不靠 AI 自觉
    ck('CC', '运行时：门头板材无厚度→内置提示厚度（拆解）',
      cluesDim.some((c) => c.indexOf('【拆解】') === 0 && c.includes('板材/字壳厚度')), JSON.stringify(cluesDim));
    ck('CC', '运行时：发光字未说LOGO/小字→内置提示字数构成（拆解）',
      cluesDim.some((c) => c.indexOf('【拆解】') === 0 && c.includes('是否含 LOGO/小字')), JSON.stringify(cluesDim));
    ck('CC', '运行时：未写施工高度→内置提示登高口径（组合）',
      cluesDim.some((c) => c.indexOf('【组合】') === 0 && c.includes('施工高度')), JSON.stringify(cluesDim));
    const cluesFull = vm.runInContext(`reviewClues(
      '门头 6米×2米 铝塑板厚2厘米 发光字5个60厘米 含LOGO及小字 离地4米',
      [{n:'铝塑板',u:'㎡',q:12,fee:1140,note:'铝塑板面板'},
       {n:'发光字',u:'㎡',q:1.8,fee:900}],
      {}, {height:'low',distanceKm:0}, {})`, ctx);
    ck('CC', '运行时：厚度/LOGO/高度都写明时三项内置提示都不再报',
      !cluesFull.some((c) => /板材\/字壳厚度|是否含 LOGO\/小字|未写离地\/施工高度/.test(c)), JSON.stringify(cluesFull));
  }

  // ===== CF：报价单价明显偏低——行业价库补口径 + price 保价纠偏 =====
  {
    const fnPath = path.join(ROOT, 'supabase/functions/estimate-ai/index.ts');
    const aiSrc = fs.readFileSync(fnPath, 'utf8');
    const helpSrc = fs.readFileSync(path.join(ROOT, 'help.html'), 'utf8');
    const aiSlice = (a, b) => {
      const i = aiSrc.indexOf(a); if (i < 0) throw new Error('ai 切片起点未找到: ' + a);
      const j = aiSrc.indexOf(b, i); if (j < 0) throw new Error('ai 切片终点未找到: ' + b);
      return aiSrc.slice(i, j);
    };
    ck('CF', '行业价库补齐按米/个材料区间，复核能识别偏低',
      aiSrc.includes('热镀锌方管/骨架（按米）') && aiSrc.includes('label: "LED灯条"')
      && aiSrc.includes('label: "电线/线缆"') && aiSrc.includes('label: "LED电源"')
      && aiSrc.includes('当前报价单价低于内置行业价对照的下限')
      && helpSrc.includes('成本写太低也会纠偏'));
    ck('CF', 'price 分支调用成本保价并标 basis=industry，锚定行不走保价',
      aiSrc.includes('function industryCostFloor(') && aiSrc.includes('const fl = industryCostFloor(x, cat);')
      && aiSrc.includes('basis: lifted ? "industry"') && aiSrc.includes('industryFloorCount: industryN')
      && aiSrc.includes('这类行你照常按类别给 rate 即可')
      && /r\.basis === "refPrice" \|\| r\.basis === "opaque" \|\| r\.basis === "industry"/.test(aiSrc)
      && appSrc.includes('b === "industry"'));
    const unitCostFn = aiSlice('function unitCost(', '// 分项利润护栏')
      .replace(/function unitCost\(x: any, key = "cost"\): number/, 'function unitCost(x, key = "cost")');
    const indSrc = aiSlice('type IndRule =', '// 有当地成交价锚定时')
      .replace(/type IndRule = \{[^}]*\};/, '')
      .replace(/const INDUSTRY_PRICE: IndRule\[\] =/, 'const INDUSTRY_PRICE =')
      .replace(/const COST_SCOPE_LABEL: Record<string, string> =/, 'const COST_SCOPE_LABEL =')
      .replace(/function itemScope\(x: any, cat: string\): string/, 'function itemScope(x, cat)')
      .replace(/function normPriceUnit\(u: any\): string/, 'function normPriceUnit(u)')
      .replace(/function industryPriceCheck\(items: any\[\]\): any\[\]/, 'function industryPriceCheck(items)')
      .replace(/function industryCostFloor\([^)]*\): \{[^}]*\} \| null/, 'function industryCostFloor(x, cat)')
      .replace(/\(x: any, i: number\)/, '(x, i)')
      .replace(/const out: any\[\] = \[\];/g, 'const out = [];');
    const ctx = { console, num: (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; } };
    vm.createContext(ctx);
    vm.runInContext(unitCostFn + '\n' + indSrc, ctx);
    const lowRows = vm.runInContext(`industryPriceCheck([
      { n:'热镀锌方管(骨架)', u:'米', cat:'mat', price:11.2, note:'' },
      { n:'LED灯条', u:'米', cat:'mat', price:5.75, note:'' },
      { n:'电线/线缆', u:'米', cat:'mat', price:2.3, note:'' },
      { n:'LED电源', u:'个', cat:'mat', price:42, note:'' }
    ])`, ctx);
    ck('CF', '运行时：截图里按米材料被判低于行业区间，电源在区间内',
      lowRows.length === 4
      && lowRows[0].label === '热镀锌方管/骨架（按米）' && lowRows[0].verdict === '低于行业区间'
      && lowRows[1].label === 'LED灯条' && lowRows[1].verdict === '低于行业区间'
      && lowRows[2].label === '电线/线缆' && lowRows[2].verdict === '低于行业区间'
      && lowRows[3].label === 'LED电源' && lowRows[3].verdict === '接近行业区间',
      JSON.stringify(lowRows));
    const fl = vm.runInContext(`industryCostFloor(
      { n:'热镀锌方管(骨架)', u:'米', q:52, fee:520, cat:'mat' }, 'mat')`, ctx);
    const flLed = vm.runInContext(`industryCostFloor(
      { n:'LED灯条', u:'米', q:24, fee:120, cat:'mat' }, 'mat')`, ctx);
    const flAlu = vm.runInContext(`industryCostFloor(
      { n:'铝塑板', u:'㎡', q:17.88, fee:1519.8, cat:'mat' }, 'mat')`, ctx);
    const flLabor = vm.runInContext(`industryCostFloor(
      { n:'门头钢架焊接/加固', u:'㎡', q:12, fee:792, cat:'labor' }, 'labor')`, ctx);
    ck('CF', '运行时：成本 ¥10/米 方管抬到行业下限需 +80%，轻微偏低/纯人工不误抬',
      !!fl && fl.rate === 80 && fl.lo === 18 && fl.why.includes('行业下限')
      && !!flLed && flLed.rate === 60
      && flAlu === null && flLabor === null,
      JSON.stringify({ fl, flLed, flAlu, flLabor }));
  }

  console.log(`\n=== 汇总：${PASS} 通过 / ${FAIL} 失败 ===`);
  if (FAIL) process.exitCode = 1;
})().catch((e) => { console.error('运行异常：', e); process.exitCode = 1; });
