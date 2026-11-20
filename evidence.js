// 依据的读法：一条依据可能只支持某个规格、某个部位、某个批次，也可能被
// 后录入的更正改掉单位或结论范围。这里把「当前有效版本」算出来，同时保留
// 原始行和更正链，方便回查。

import { parseClaim, chineseToNumber, detectUnit } from './claims.js';

const CORRECTION_MARKERS = /应为|应改为|更正|订正|改为|笔误|误写|单位是|指的是/;

/**
 * 读出单条依据，并标出它引用了哪条依据（用于识别更正）。
 */
export function interpretEvidence(row, specs) {
  const text = row.text;
  const claim = parseClaim(text, { recordId: row.id, specs });
  const refs = [...new Set([...text.matchAll(/\b(r\d+)\b/g)].map(match => match[1]))]
    .filter(id => id !== row.id);
  const isCorrection = refs.length > 0 && CORRECTION_MARKERS.test(text);

  return {
    id: row.id,
    issued: row.issued,
    text,
    kind: isCorrection ? 'correction' : 'base',
    target: isCorrection ? refs[0] : null,
    claim,
    // 依据本身所限定的对象，供规格覆盖判断使用。
    batch: claim.batch,
    materials: [...new Set(claim.object.materials)],
    part: claim.object.part,
    sample: claim.object.sample,
    notWhole: claim.object.notWhole,
    affirmativeChange: claim.affirmedChange,
    negated: claim.negated,
    quantity: claim.quantity,
    condition: claim.condition,
    restrictions: claim.restrictions,
    correction: isCorrection ? readCorrection(text, claim) : null
  };
}

/**
 * 读出更正的内容：改的是哪条依据的哪个量。
 */
function readCorrection(text, claim) {
  const unitMatch = /单位应?为\s*(毫米|厘米|米|mm|cm|m)/i.exec(text);
  const unit = unitMatch ? detectUnit(unitMatch[1]) : null;
  const numberMatch = /(?:数值|数字|数据)应?改为\s*(\d+(?:\.\d+)?|[零〇一二两三四五六七八九十百]+)/.exec(text);
  const scope = [];
  if (claim.object.sample || /只针对样条|只对样条|仅针对样条/.test(text)) scope.push('sample');
  if (claim.object.notWhole || /不追溯(?:整件|成品|整套|全套)/.test(text)) scope.push('not-whole');
  if (/只针对|只适用|仅限于|只检了|只测了/.test(text)) scope.push('only');
  return {
    unit,
    value: numberMatch ? chineseToNumber(numberMatch[1]) : null,
    scope,
    raw: text
  };
}

/**
 * 计算每条依据的当前有效版本：按录入日期（同日按资料顺序）叠加更正。
 */
export function effectiveEvidence(rows, specs) {
  const interpreted = rows.map((row, index) => ({
    ...interpretEvidence(row, specs),
    index
  }));
  const corrections = new Map();
  for (const row of interpreted) {
    if (!row.kind || row.kind !== 'correction') continue;
    if (!corrections.has(row.target)) corrections.set(row.target, []);
    corrections.get(row.target).push(row);
  }

  const effective = [];
  for (const row of interpreted) {
    if (row.kind === 'correction') continue;
    const applied = (corrections.get(row.id) ?? [])
      .sort((a, b) => a.issued.localeCompare(b.issued) || a.index - b.index);
    const current = clone(row);
    for (const correction of applied) {
      if (correction.correction.unit) {
        if (current.quantity) {
          current.quantity = { ...current.quantity, unit: correction.correction.unit };
          current.claim.quantities = current.claim.quantities.map(item =>
            item === current.claim.quantity ? current.quantity : item);
          current.claim.quantity = current.quantity;
          if (current.claim.comparison) current.claim.comparison = { ...current.claim.comparison, unit: correction.correction.unit };
        }
      }
      if (correction.correction.value != null && current.quantity) {
        current.quantity = { ...current.quantity, value: correction.correction.value };
        current.claim.quantity = current.quantity;
        if (current.claim.comparison) current.claim.comparison = { ...current.claim.comparison, value: correction.correction.value };
      }
      for (const scope of correction.correction.scope) {
        if (scope === 'sample') current.sample = true;
        if (scope === 'not-whole') current.notWhole = true;
        if (scope === 'only') current.restricted = true;
      }
      current.appliedCorrections = [...(current.appliedCorrections ?? []), correction.id];
    }
    current.validity = {
      issued: row.issued,
      correctedOn: applied.at(-1)?.issued ?? null,
      batches: current.batch ? [current.batch] : [],
      scopeNote: current.text
    };
    effective.push(current);
  }
  return { effective, corrections: [...corrections.values()].flat(), interpreted };
}

function clone(value) {
  return {
    ...value,
    quantity: value.quantity ? { ...value.quantity } : null,
    condition: { ...value.condition },
    claim: {
      ...value.claim,
      quantity: value.claim.quantity ? { ...value.claim.quantity } : null,
      quantities: value.claim.quantities.map(item => ({ ...item })),
      comparison: value.claim.comparison ? { ...value.claim.comparison } : null,
      object: { ...value.claim.object, materials: [...value.claim.object.materials] }
    }
  };
}

/**
 * 一条依据是否覆盖某个规格。
 */
export function evidenceCoversSpec(evidence, spec) {
  if (evidence.batch && evidence.batch !== spec.batch) return false;
  if (evidence.materials.length > 0) {
    const matches = evidence.materials.some(material =>
      material === spec.outer || material === spec.lining);
    if (!matches) return false;
  }
  if (evidence.part === 'outer' && evidence.materials.length === 0 && !spec.outer) return false;
  if (evidence.part === 'lining' && evidence.materials.length === 0 && !spec.lining) return false;
  return true;
}
