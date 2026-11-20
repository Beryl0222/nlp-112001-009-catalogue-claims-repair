import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseClaim, compareClaims, chineseToNumber } from '../claims.js';
import { effectiveEvidence, evidenceCoversSpec } from '../evidence.js';
import { reviewListing, reviewSeries, suggestRewrite } from '../review.js';
import { buildWorkbench } from '../workbench.js';
import { readMaterials } from '../materials.js';

const materials = await readMaterials();
const specs = materials['规格.json'];
const evidenceRows = materials['依据.json'];
const listings = materials['展位稿.json'];
const constraints = materials['展示约束.json'];
const { effective, corrections } = effectiveEvidence(evidenceRows, specs);
const reviews = listings.map(row => reviewListing(row, specs, effective, constraints, listings));
const byId = id => reviews.find(item => item.id === id);
const rowById = id => listings.find(item => item.id === id);

test('读出对象、数值单位、情形、比较、否定和限制', () => {
  const claim = parseClaim('半小时内长度变化不到 2%', { specs });
  assert.equal(claim.object.kind, 'unspecified');
  assert.equal(claim.quantity.value, 2);
  assert.equal(claim.quantity.unit, 'percent');
  assert.equal(claim.quantity.operator, 'lt');
  assert.equal(claim.quantities[0].source.text, '不到 2%');
  assert.equal(claim.condition.water, false);
  assert.equal(claim.condition.durationMinutes, 30);
  assert.equal(claim.condition.within, true);
  assert.equal(claim.comparison.subject, 'length-change');
  assert.equal(claim.negated, false);
  assert.equal(claim.ambiguousQuantity, 'quantity-without-object');

  const broad = parseClaim('整件遇水不变形', { specs });
  assert.equal(broad.object.whole, true);
  assert.equal(broad.object.sample, false);
  assert.equal(broad.negated, true);
  assert.equal(broad.absolute, true);
  assert.equal(broad.condition.water, true);
  assert.equal(broad.comparison.subject, 'dimension-change');
});

test('中文数字、半和否定限定都能读出', () => {
  assert.equal(chineseToNumber('二'), 2);
  assert.equal(chineseToNumber('十二'), 12);
  assert.equal(chineseToNumber('半'), 0.5);
  const claim = parseClaim('仅指春甲批外层样条，清水浸湿半小时', { specs });
  assert.equal(claim.batch, '春甲');
  assert.equal(claim.only, true);
  assert.equal(claim.object.sample, true);
  assert.equal(claim.object.part, 'outer');
  assert.equal(claim.condition.durationMinutes, 30);
  const corrected = parseClaim('r1 的单位应为毫米，结论只针对样条，不追溯整件成品。', { specs });
  assert.equal(corrected.object.notWhole, true);
  assert.equal(corrected.object.sample, true);
  assert.equal(corrected.negated, false);
});

test('按当前有效依据判断，更正后的单位覆盖原依据', () => {
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].target, 'r1');
  const r1 = effective.find(item => item.id === 'r1');
  assert.equal(r1.quantity.unit, 'millimetre');
  assert.equal(r1.quantity.value, 2);
  assert.deepEqual(r1.appliedCorrections, ['r3']);
  assert.equal(r1.notWhole, true);
  assert.equal(r1.validity.correctedOn, '2026-09-08');
  const r2 = effective.find(item => item.id === 'r2');
  assert.equal(r2.affirmativeChange, true);
  assert.equal(r2.quantity, null);
});

test('依据只覆盖被检批次和部位', () => {
  const r1 = effective.find(item => item.id === 'r1');
  const r2 = effective.find(item => item.id === 'r2');
  assert.equal(evidenceCoversSpec(r1, specs[0]), true);
  assert.equal(evidenceCoversSpec(r1, specs[1]), false);
  assert.equal(evidenceCoversSpec(r1, specs[2]), false);
  assert.equal(evidenceCoversSpec(r2, specs[1]), true);
  assert.equal(evidenceCoversSpec(r2, specs[0]), false);
  assert.equal(evidenceCoversSpec(r2, specs[2]), false);
});

test('逐稿给出停止、保留的结论和依据', () => {
  assert.equal(byId('l1').status, 'stop');
  assert.equal(byId('l2').status, 'keep');
  assert.equal(byId('l3').status, 'stop');
  assert.equal(byId('l4').status, 'keep');

  assert.ok(byId('l1').problems.some(item => item.code === 'claim:overbroad-object'));
  assert.ok(byId('l1').problems.some(item => item.code === 'claim:contradicted'));
  assert.ok(byId('l1').problems.some(item => item.code === 'basis:partial-coverage'));
  assert.deepEqual(byId('l1').basis.missing, ['se1', 'se2', 'se3']);

  assert.ok(byId('l3').problems.some(item => item.code === 'claim:unit-mismatch'));
  assert.deepEqual(byId('l3').basis.missing, ['se1', 'se2']);
});

test('限定与卖点不能同处可见时不能按原形式上架', () => {
  const short = byId('l3');
  assert.equal(short.context.placement, 'separate');
  assert.ok(short.context.missing.includes('batch:春甲'));
  assert.ok(short.problems.some(item => item.code === 'context:qualifiers-not-visible'));

  const title = byId('l1');
  assert.equal(title.context.placement, 'together');
  assert.ok(title.context.missing.length > 0);
  assert.ok(title.problems.some(item => item.code === 'context:qualifiers-partial'));
  assert.equal(byId('l2').context.missing.length, 0);
});

test('短卡放不下限定时可改投其他渠道，同一改稿仍可用', () => {
  const short = byId('l3');
  const suggestion = suggestRewrite(short, effective, constraints, reviews);
  assert.equal(suggestion.placement, 'separate');
  assert.equal(suggestion.batch, '春甲');
  assert.ok(suggestion.suggestions.some(item => item.kind === 'channel-scope'));
  assert.ok(suggestion.suggestions.some(item => item.kind === 'align-measure'));
  assert.deepEqual(suggestion.reusableIn.map(item => item.id), ['l4']);
  assert.equal(byId('l4').status, 'keep');
});

test('系列共用描述只有在每个规格都有依据时才整体放行', () => {
  const series = reviewSeries('听雨旅行罩', specs, effective, listings, constraints);
  assert.equal(series.approved, false);
  assert.equal(series.propagateToSeries, false);
  const perSpec = Object.fromEntries(series.specs.map(item => [item.spec.id, item]));
  assert.equal(perSpec.se1.covered, true);
  assert.deepEqual(perSpec.se1.evidence.map(item => item.id), ['r1']);
  assert.equal(perSpec.se1.evidence[0].unit, 'millimetre');
  assert.equal(perSpec.se2.covered, true);
  assert.deepEqual(perSpec.se2.affectedListings, ['l1', 'l3']);
  assert.equal(perSpec.se3.covered, false);
  assert.deepEqual(perSpec.se3.affectedListings, ['l1']);
});

test('比较改稿时区分缩小、放宽和数值更正', () => {
  const broad = parseClaim('整件遇水不变形', { specs });
  const narrow = parseClaim(rowById('l4').text, { specs });
  const narrowing = compareClaims(broad, narrow);
  assert.equal(narrowing.safeToReview, true);
  assert.equal(narrowing.kind, 'narrowed');
  assert.ok(narrowing.added.some(item => item.code === 'restriction:batch'));
  assert.ok(narrowing.added.some(item => item.code === 'object:sample'));
  assert.ok(narrowing.removed.some(item => item.code === 'object:whole'));

  const widened = compareClaims(
    parseClaim('仅指春甲批外层样条，清水浸湿半小时', { specs }),
    parseClaim('甲纤外层样条清水浸湿半小时', { specs })
  );
  assert.equal(widened.safeToReview, false);
  assert.equal(widened.kind, 'widened');
  assert.ok(widened.removed.some(item => item.code === 'restriction:batch'));

  const corrected = compareClaims(
    parseClaim('半小时内长度变化不到 2%', { specs }),
    parseClaim('长度变化不到两毫米', { specs })
  );
  assert.equal(corrected.changed[0].code, 'quantity:unit');
  assert.equal(corrected.changed[0].from, 'percent');
  assert.equal(corrected.changed[0].to, 'millimetre');
  // 删掉时长限定是放宽结论窗口，不能当作「只改了单位」放行。
  assert.equal(corrected.safeToReview, false);
  assert.ok(corrected.removed.some(item => item.code === 'condition:duration'));
});

test('量词没有对象线索时交审阅人确认，不自动当成成品效果', () => {
  const claim = parseClaim('半小时内长度变化不到两毫米', { specs });
  assert.equal(claim.ambiguousQuantity, 'quantity-without-object');
  const review = reviewListing(
    { id: 'x1', channel: '网页', location: '详情页底', scope: 'se1', part: '主文', text: claim.text },
    specs, effective, constraints, listings
  );
  assert.equal(review.status, 'review');
  assert.ok(review.problems.some(item => item.code === 'claim:ambiguous-quantity'));
  assert.ok(!review.problems.some(item => item.severity === 'blocking'));
});

test('工作台汇总已上线文字的处置和受影响规格', async () => {
  const result = await buildWorkbench();
  const live = Object.fromEntries(result.live.map(item => [item.id, item]));
  assert.equal(live.l1.action, '停止展示');
  assert.equal(live.l2.action, '保留');
  assert.equal(live.l3.action, '停止展示');
  assert.equal(live.l4.action, '保留');
  assert.deepEqual(live.l4.basis.map(item => item.spec), ['se1']);
  assert.equal(result.evidence.current.find(item => item.id === 'r1').quantity.unit, 'millimetre');
  const se3 = result.series[0].specs.find(item => item.spec.id === 'se3');
  assert.deepEqual(se3.affectedListings, ['l1']);
});

test('已批准版本保留依据版本和有效期，可回查', async () => {
  const result = await buildWorkbench();
  const approved = Object.fromEntries(result.approvals.map(item => [item.listingId, item]));
  assert.deepEqual(Object.keys(approved).sort(), ['l2', 'l4']);
  assert.equal(approved.l4.source.recordId, 'l4');
  assert.equal(approved.l4.source.start, 0);
  assert.equal(approved.l4.source.end, approved.l4.text.length);
  assert.deepEqual(approved.l4.scope, ['se1']);
  assert.deepEqual(approved.l4.evidence, [{
    spec: 'se1',
    evidence: [{ id: 'r1', issued: '2026-09-01', correctedOn: '2026-09-08', unit: 'millimetre' }]
  }]);
  // 更正只落在 se1 采用的依据上，不变成整个系列的批准。
  assert.equal(approved.l2.scope.includes('se2'), false);
  assert.equal(approved.l2.scope.includes('se3'), false);
});

test('缺依据的规格只停在受影响稿件，不扩散到已批准稿件', async () => {
  const result = await buildWorkbench();
  const se3 = result.series[0].specs.find(item => item.spec.id === 'se3');
  assert.equal(se3.covered, false);
  assert.deepEqual(se3.affectedListings, ['l1']);
  const affected = result.series[0].listings
    .filter(item => item.scopeIds.includes('se3') && !item.passed)
    .map(item => item.id);
  assert.deepEqual(affected, ['l1']);
});

test('展示约束为主文单独出现时给出投放范围建议，不靠文字改写掩盖', () => {
  const short = byId('l3');
  const suggestion = suggestRewrite(short, effective, constraints, reviews);
  const channel = suggestion.suggestions.find(item => item.kind === 'channel-scope');
  assert.ok(channel);
  assert.match(channel.note, /其他渠道/);
  assert.equal(suggestion.suggestions.some(item =>
    item.kind === 'place-qualifiers' && item.adds.length === 0), false);
  // 短卡的改写建议不能声称能保留全部限定原样上架。
  assert.equal(byId('l3').passed, false);
});
