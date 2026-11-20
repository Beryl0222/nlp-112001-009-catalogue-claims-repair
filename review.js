// 审阅：把稿件声明和当前有效依据、渠道展示约束放在一起判断。
//
// 原则：
//  - 声明必须有覆盖到的规格的依据才能上架；系列共用描述要逐个规格核对。
//  - 限定（批次、部位、样条、时长）与卖点不在同一位置时，按原形式不能上架。
//  - 短卡兼容失败时缩小声明或取消该渠道投放；同一改稿在能完整展示限定的
//    其他渠道仍可继续使用。
//  - 输出总是逐条给依据和原文范围，便于运营回查，不做批量替换。

import { effectiveEvidence, evidenceCoversSpec } from './evidence.js';
import { parseClaim, unitLabel, operatorLabel } from './claims.js';

/**
 * 读取一份渠道稿件，解析作用规格。
 */
export function interpretListing(row, specs) {
  const scopeIds = typeof row.scope === 'string' && row.scope.length > 0
    ? row.scope.split(/[、,，]/).map(part => part.trim()).filter(Boolean)
    : specs.map(spec => spec.id);
  const scopeSpecs = specs.filter(spec => scopeIds.includes(spec.id));
  const claim = parseClaim(row.text, { recordId: row.id, specs });
  return { ...row, scopeIds, scopeSpecs, claim };
}

/**
 * 找出能支持某条声明（针对一组规格）的依据。
 */
export function basisFor(claim, scopeSpecs, evidence) {
  const covered = [];
  const missing = [];
  for (const spec of scopeSpecs) {
    const supporting = evidence.filter(item =>
      evidenceCoversSpec(item, spec) && claimSupportedBy(claim, item));
    if (supporting.length === 0) missing.push(spec.id);
    else covered.push({ spec: spec.id, evidence: supporting.map(item => item.id) });
  }
  return {
    covered,
    missing,
    // 共用描述只有在每个规格都有依据时才整体放行。
    wholeScopeCovered: missing.length === 0 && scopeSpecs.length > 0,
    allScopeSpecs: scopeSpecs.map(item => item.id),
    coveredSpecs: covered.map(item => item.spec)
  };
}

function claimSupportedBy(claim, evidence) {
  if (evidence.affirmativeChange && claim.negated) return false;
  if (claim.object.whole && (evidence.sample || evidence.notWhole)) return false;

  const claimedPart = effectivePart(claim);
  if (claimedPart && evidence.part && claimedPart !== evidence.part) return false;

  const material = claim.object.materials[0];
  if (material && evidence.materials.length > 0 && !evidence.materials.includes(material)) return false;

  if (claim.quantity) {
    if (!evidence.quantity) return false;
    if (claim.quantity.unit !== evidence.quantity.unit) return false;
    if (claim.quantity.operator !== evidence.quantity.operator) {
      // 「不超过」可以由「小于」支持，反向不行。
      if (!(claim.quantity.operator === 'lte' && evidence.quantity.operator === 'lt')) return false;
    }
    if (claim.quantity.value !== evidence.quantity.value) return false;
  }
  if (claim.condition.water && !evidence.condition.water) return false;
  return true;
}

function effectivePart(claim) {
  if (claim.object.sample && claim.object.part === null) return 'sample';
  return claim.object.part;
}

/**
 * 依据对某个规格提出的、必须与卖点同处可见的限定。
 */
function qualifiersFromEvidence(evidence) {
  const set = new Set();
  if (evidence.batch) set.add(`batch:${evidence.batch}`);
  if (evidence.sample || evidence.notWhole) set.add('sample');
  if (evidence.part) set.add(`part:${evidence.part}`);
  if (evidence.condition.durationMinutes != null) {
    set.add(`duration:${evidence.condition.durationMinutes}`);
  }
  return set;
}

/**
 * 一条文稿自身写出的限定（用于旁注和改稿）。
 */
export function qualifiersOfClaim(claim) {
  const set = new Set();
  if (claim.batch) set.add(`batch:${claim.batch}`);
  if (claim.object.sample || claim.object.notWhole) set.add('sample');
  if (claim.object.part) set.add(`part:${claim.object.part}`);
  if (claim.condition.durationMinutes != null) {
    set.add(`duration:${claim.condition.durationMinutes}`);
  }
  return set;
}

/**
 * 审阅单条稿件。
 */
export function reviewListing(row, specs, evidence, constraints = [], listings = []) {
  const listing = interpretListing(row, specs);
  const claim = listing.claim;
  const constraint = constraints.find(item => item.location === row.location);
  const placement = constraint ? readConstraint(constraint) : { kind: 'unknown', raw: null };
  const basis = basisFor(claim, listing.scopeSpecs, evidence);

  const problems = [];

  if (claim.object.whole && !claim.object.notWhole) {
    const sampleOnly = evidence.length > 0 && evidence.every(item => item.sample || item.notWhole);
    if (sampleOnly) {
      problems.push({
        code: 'claim:overbroad-object',
        severity: 'blocking',
        message: '声明指向整件，但现有依据只支持样条/外层被试部分',
        evidence: evidence.map(item => item.id)
      });
    }
  }

  if (claim.negated && claim.absolute) {
    const affirmative = evidence.filter(item => item.affirmativeChange);
    for (const item of affirmative) {
      problems.push({
        code: 'claim:contradicted',
        severity: 'blocking',
        message: `声明称遇水不变形，但依据 ${item.id} 记载${item.materials.join('、') || '内衬'}遇水会有尺寸变化`,
        evidence: [item.id]
      });
    }
  }

  if (claim.quantity) {
    for (const item of evidence) {
      if (!item.quantity || item.quantity.unit === claim.quantity.unit) continue;
      // 只看在本稿作用规格内有覆盖的依据，避免把无关批次的更正当成本稿问题。
      if (!listing.scopeSpecs.some(spec => evidenceCoversSpec(item, spec))) continue;
      problems.push({
        code: 'claim:unit-mismatch',
        severity: 'blocking',
        message: `稿件用${unitLabel(claim.quantity.unit)}（${claim.quantity.value}），当前有效依据 ${item.id} 用${unitLabel(item.quantity.unit)}`,
        evidence: [item.id]
      });
    }
  }

  if (listing.scopeSpecs.length > 0 && basis.missing.length > 0) {
    problems.push({
      code: 'basis:partial-coverage',
      severity: 'blocking',
      message: `以下规格缺少依据覆盖：${basis.missing.join('、')}`,
      specs: basis.missing
    });
  }

  // 渠道呈现：限定必须能与卖点同处可见。
  const context = reviewContext(listing, evidence, placement, listings, constraints, specs);
  if (context.required.size > 0 && context.missing.size > 0) {
    const labels = [...context.missing].map(qualifierLabel);
    if (placement.kind === 'separate') {
      problems.push({
        code: 'context:qualifiers-not-visible',
        severity: 'blocking',
        message: `本渠道「${row.location}」主文单独出现，必要限定（${labels.join('、')}）无法与卖点同时可见`,
        qualifiers: [...context.missing],
        constraint: constraint?.id ?? null
      });
    } else if (placement.kind === 'together') {
      problems.push({
        code: 'context:qualifiers-partial',
        severity: 'blocking',
        message: `同处可见的旁注没有覆盖全部规格的限定（${labels.join('、')}）`,
        qualifiers: [...context.missing],
        constraint: constraint?.id ?? null
      });
    } else {
      problems.push({
        code: 'context:unknown-placement',
        severity: 'review',
        message: `缺少「${row.location}」的展示约束，无法确认限定（${labels.join('、')}）是否与卖点同处可见`,
        qualifiers: [...context.missing]
      });
    }
  }

  if (claim.ambiguousQuantity && !problems.some(item => item.severity === 'blocking')) {
    problems.push({
      code: 'claim:ambiguous-quantity',
      severity: 'review',
      message: '量词没有对象线索：既可能指材料性能，也可能指成品效果，需审阅人确认对应依据',
      evidence: basis.covered.flatMap(item => item.evidence)
    });
  }

  const blocking = problems.some(item => item.severity === 'blocking');
  const needsReview = problems.some(item => item.severity === 'review');

  return {
    id: row.id,
    channel: row.channel,
    location: row.location,
    part: row.part,
    text: row.text,
    // 原文位置：记录编号加文本范围，便于回查具体措辞。
    source: { recordId: row.id, start: 0, end: row.text.length, text: row.text },
    scopeIds: listing.scopeIds,
    claim,
    basis,
    context: {
      placement: placement.kind,
      raw: placement.raw,
      required: [...context.required],
      missing: [...context.missing]
    },
    ambiguousQuantity: claim.ambiguousQuantity,
    problems,
    status: blocking ? 'stop' : needsReview ? 'review' : 'keep',
    passed: !blocking
  };
}

/**
 * 逐规格判断必要限定是否在「卖点所在位置」可见。
 * together 约束下，同一位置、覆盖该规格的旁注可以补足限定。
 */
function reviewContext(listing, evidence, placement, listings, constraints, specs) {
  const required = new Set();
  const missing = new Set();
  const companions = listings
    .filter(other => other.id !== listing.id && other.location === listing.location)
    .map(other => interpretListing(other, specs));

  for (const spec of listing.scopeSpecs) {
    // 这里看「该规格受哪些依据约束」，而不要求该依据一定能支持本条声明；
    // 否则缺少依据时反而看不出限定缺失。
    const relevant = evidence.filter(item => evidenceCoversSpec(item, spec));
    const needed = new Set();
    for (const item of relevant) for (const qualifier of qualifiersFromEvidence(item)) needed.add(qualifier);

    const present = qualifiersOfClaim(listing.claim);
    const companionQualifiers = new Set();
    if (placement.kind === 'together') {
      for (const companion of companions) {
        if (!companion.scopeIds.includes(spec.id)) continue;
        for (const qualifier of qualifiersOfClaim(companion.claim)) companionQualifiers.add(qualifier);
      }
    }

    for (const qualifier of needed) {
      required.add(qualifier);
      if (!present.has(qualifier) && !companionQualifiers.has(qualifier)) {
        missing.add(qualifier);
      }
    }
  }
  return { required, missing };
}

function qualifierLabel(code) {
  if (code === 'sample') return '样条限定';
  if (code.startsWith('batch:')) return `批次 ${code.slice(6)}`;
  if (code.startsWith('part:')) return code.endsWith('outer') ? '外层限定' : '内衬限定';
  if (code.startsWith('duration:')) return `时长 ${code.slice(9)} 分钟`;
  return code;
}

function readConstraint(row) {
  const raw = row.together ?? '';
  if (/同时可见|同一位置|同处|一起展示/.test(raw)) return { kind: 'together', raw };
  if (/单独出现|另页|不同位置|分开/.test(raw)) return { kind: 'separate', raw };
  return { kind: 'unknown', raw };
}

/**
 * 系列：逐规格核对共用描述，一个规格的更正不自动传播成整个系列的结论。
 */
export function reviewSeries(series, specs, evidence, listings, constraints) {
  const seriesSpecs = specs.filter(item => item.series === series);
  const seriesSpecIds = new Set(seriesSpecs.map(item => item.id));
  // 只汇总作用到本系列的稿件；其他系列的稿件不参与本系列结论。
  const seriesListings = listings.filter(row => {
    const ids = typeof row.scope === 'string' && row.scope.length > 0
      ? row.scope.split(/[、,，]/).map(part => part.trim())
      : specs.map(spec => spec.id);
    return ids.some(id => seriesSpecIds.has(id));
  });
  const results = seriesListings.map(row => reviewListing(row, specs, evidence, constraints, seriesListings));
  const perSpec = seriesSpecs.map(spec => {
    const affected = results.filter(result =>
      result.scopeIds.includes(spec.id) && !result.passed);
    const covering = evidence.filter(item => evidenceCoversSpec(item, spec));
    return {
      spec,
      evidence: covering.map(item => ({
        id: item.id,
        issued: item.issued,
        correctedOn: item.validity?.correctedOn ?? null,
        batch: item.batch,
        part: item.part,
        unit: item.quantity?.unit ?? null
      })),
      affectedListings: affected.map(item => item.id),
      covered: covering.length > 0
    };
  });
  return {
    series,
    specs: perSpec,
    listings: results,
    approved: results.every(item => item.passed),
    // 一个规格的更正不能自动传播成整个系列的结论。
    propagateToSeries: false
  };
}

/**
 * 给出受页面呈现约束的改写建议。只在能保留原意的前提下缩小范围。
 */
export function suggestRewrite(listing, evidence, constraints = [], siblings = []) {
  const claim = listing.claim;
  const constraint = constraints.find(item => item.location === listing.location);
  const placement = constraint ? readConstraint(constraint) : { kind: 'unknown', raw: null };
  const suggestions = [];
  const batch = claim.batch ?? evidence.find(item => item.batch)?.batch ?? null;
  // 改写里的数值和单位只能来自当前有效依据，不能套用稿件里的数。
  const measured = evidence.find(item => item.quantity);
  const validity = evidence
    .map(item => ({ id: item.id, issued: item.issued, correctedOn: item.validity?.correctedOn ?? null }))
    .sort((a, b) => String(a.issued).localeCompare(String(b.issued)));

  if (claim.object.whole) {
    const narrowedText = measured
      ? `${batch ? `${batch}` : ''}外层样条遇水长度变化${operatorLabel(measured.quantity.operator)}${smallNumberLabel(measured.quantity.value)}${unitLabel(measured.quantity.unit)}`
      : '（按依据可覆盖的批次、部位和样条重写对象）';
    suggestions.push({
      kind: 'narrow-object',
      target: 'object',
      text: narrowedText,
      keeps: ['water', 'comparison:length-change'],
      adds: ['sample', 'part:outer', ...(batch ? [`batch:${batch}`] : [])],
      evidence: measured ? [measured.id] : [],
      note: `把对象从整件缩到有依据的样条与外层${listing.scopeIds.length > 1
        ? `；该写法只覆盖 ${measured?.batch ?? batch ?? '被检批次'} 对应规格，需相应收窄 scope` : ''}`
    });
  }

  if (claim.quantity && claim.quantity.unit === 'percent') {
    const corrected = evidence.find(item => item.quantity && item.quantity.unit !== 'percent');
    suggestions.push({
      kind: 'align-measure',
      target: 'quantity',
      text: corrected
        ? `长度变化不到${smallNumberLabel(corrected.quantity.value)}${unitLabel(corrected.quantity.unit)}`
        : '长度变化（按当前有效依据的单位）',
      keeps: ['condition:duration'],
      changes: [{
        from: `${claim.quantity.unit}:${claim.quantity.value}`,
        to: corrected ? `${corrected.quantity.unit}:${corrected.quantity.value}` : null
      }],
      evidence: corrected ? [corrected.id] : [],
      note: '百分比与毫米不能互换，按更正后的依据改写，不批量替换'
    });
  }

  if (listing.context?.missing?.length > 0) {
    suggestions.push({
      kind: 'place-qualifiers',
      target: 'placement',
      text: '把批次、样条、部位和时长限定写到卖点同一位置',
      keeps: [],
      adds: listing.context.missing,
      note: placement.kind === 'separate'
        ? '本渠道主文单独出现，放不下限定'
        : '同处可见的旁注需覆盖全部规格'
    });
    if (placement.kind === 'separate') {
      suggestions.push({
        kind: 'channel-scope',
        target: 'scope',
        text: '取消本渠道投放，或改用无需限定的更窄声明',
        keeps: [],
        note: '同一改稿在能完整展示限定的其他渠道仍可使用'
      });
    }
  }

  const reusable = siblings
    .filter(other => other.id !== listing.id
      && other.part === '改稿'
      && other.status === 'keep'
      && other.location !== listing.location)
    .map(other => ({ id: other.id, channel: other.channel, location: other.location, text: other.text }));

  return {
    id: listing.id,
    channel: listing.channel,
    location: listing.location,
    placement: placement.kind,
    batch,
    validity,
    suggestions,
    reusableIn: reusable
  };
}

function smallNumberLabel(value) {
  return { 0.5: '半', 1: '一', 2: '两', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九', 10: '十' }[value]
    ?? String(value);
}
