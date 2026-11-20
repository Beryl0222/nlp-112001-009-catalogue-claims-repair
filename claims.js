// 声明与依据的文字解析。
//
// 这里只做「读出」：把一段中文文案拆成对象、数值与单位、情形、比较对象、
// 否定和限制，并为每条事实保留原文范围。是否成立由 review.js 判断。

const CN_DIGITS = new Map([
  ['零', 0], ['〇', 0], ['一', 1], ['二', 2], ['两', 2], ['三', 3],
  ['四', 4], ['五', 5], ['六', 6], ['七', 7], ['八', 8], ['九', 9]
]);
const CN_NUMBER = '[零〇一二两三四五六七八九十百]+';
const NUMBER = `(?:\\d+(?:\\.\\d+)?|${CN_NUMBER}|半)`;
const OPERATOR = '(不到|小于|低于|不足|少于|不超过|至多|最多|大于|高于|超过|不少于|至少)?';

export function chineseToNumber(raw) {
  const text = String(raw).trim();
  if (/^\d+(?:\.\d+)?$/.test(text)) return Number(text);
  if (text === '半') return 0.5;

  let total = 0;
  let section = 0;
  let digit = 0;
  for (const char of text) {
    if (CN_DIGITS.has(char)) {
      digit = CN_DIGITS.get(char);
    } else if (char === '十') {
      section += (digit || 1) * 10;
      digit = 0;
    } else if (char === '百') {
      section += (digit || 1) * 100;
      digit = 0;
    } else if (char === '千') {
      section += (digit || 1) * 1000;
      digit = 0;
    } else if (char === '万') {
      total += (section + digit) * 10000;
      section = 0;
      digit = 0;
    }
  }
  return total + section + digit;
}

function operatorOf(word) {
  if (!word) return 'eq';
  if (/不到|小于|低于|不足|少于/.test(word)) return 'lt';
  if (/不超过|至多|最多/.test(word)) return 'lte';
  if (/大于|高于|超过/.test(word)) return 'gt';
  if (/不少于|至少/.test(word)) return 'gte';
  return 'eq';
}

export function detectUnit(word) {
  if (/百分|%/.test(word)) return 'percent';
  if (/毫米|公厘|mm/i.test(word)) return 'millimetre';
  if (/厘米|cm/i.test(word)) return 'centimetre';
  if (/米|m/i.test(word)) return 'metre';
  return null;
}

function spanOf(text, match, index) {
  const start = match.index + (index ?? 0);
  const end = start + match[0].length;
  return { start, end, text: text.slice(start, end) };
}

function fact(code, value, label, source, extra = {}) {
  return { code, value, label, source, ...extra };
}

function collect(regex, text, callback) {
  regex.lastIndex = 0;
  let match;
  while ((match = regex.exec(text)) !== null) {
    callback(match);
    if (match[0].length === 0) regex.lastIndex += 1;
  }
}

function uniqueBy(array, key) {
  const seen = new Set();
  return array.filter(item => {
    const value = key(item);
    if (seen.has(value)) return false;
    seen.add(value);
    return true;
  });
}

/**
 * 读出文字中的对象、数值、情形、比较对象、否定和限制。
 *
 * @param {string} text 原文
 * @param {{recordId?: string, specs?: Array<object>}} [options]
 */
export function parseClaim(text, options = {}) {
  if (typeof text !== 'string') throw new TypeError('原文必须是字符串');
  const recordId = options.recordId ?? null;
  const specs = Array.isArray(options.specs) ? options.specs : [];
  const facts = [];

  // ---- 对象 ----
  const wholeMatches = [];
  const sampleMatches = [];
  const outerMatches = [];
  const liningMatches = [];
  collect(/整件|整套|全件|成品|全套|全部产品|全部商品|所有产品|所有商品|整个(?:产品|商品|系列)?/g, text, match => {
    wholeMatches.push({ match, value: match[0] });
  });
  collect(/样条|样品|试样/g, text, match => {
    sampleMatches.push({ match, value: match[0] });
  });
  collect(/外层|面料|表面|外层织物|外层面料/g, text, match => {
    outerMatches.push({ match, value: match[0] });
  });
  collect(/内衬|里料|内层/g, text, match => {
    liningMatches.push({ match, value: match[0] });
  });

  const materials = [];
  const materialTokens = new Map();
  for (const spec of specs) {
    for (const field of ['outer', 'lining']) {
      const value = spec?.[field];
      if (typeof value !== 'string' || value.length === 0) continue;
      materialTokens.set(value, value);
      const base = value.replace(/(?:织物|面料|布料|棉布)$/u, '');
      if (base.length >= 2) materialTokens.set(base, value);
    }
  }
  for (const [token, material] of materialTokens) {
    let index = text.indexOf(token);
    while (index !== -1) {
      materials.push({
        token,
        material,
        source: { start: index, end: index + token.length, text: token }
      });
      index = text.indexOf(token, index + token.length);
    }
  }
  for (const material of uniqueBy(materials, item => `${item.material}@${item.source.start}`)) {
    facts.push(fact('object:material', material.material, `材料 ${material.material}`,
      material.source, { recordId }));
  }

  const sample = sampleMatches.length > 0;
  const whole = wholeMatches.length > 0;
  const part = liningMatches.length > 0 && outerMatches.length === 0
    ? 'lining'
    : outerMatches.length > 0 ? 'outer' : null;
  const objectKind = sample ? 'sample' : whole ? 'whole' : part ?? 'unspecified';

  for (const match of wholeMatches) {
    facts.push(fact('object:whole', true, '对象为整件/成品', spanOf(text, match.match), { recordId }));
  }
  for (const match of sampleMatches) {
    facts.push(fact('object:sample', true, '对象为样条/样品', spanOf(text, match.match), { recordId }));
  }
  for (const match of outerMatches) {
    facts.push(fact(`object:${part === 'lining' ? 'lining' : 'outer'}`, true,
      part === 'lining' ? '对象为内衬' : '对象为外层', spanOf(text, match.match), { recordId }));
  }
  for (const match of liningMatches) {
    facts.push(fact('object:lining', true, '对象为内衬', spanOf(text, match.match), { recordId }));
  }

  // 「不追溯整件成品」是限制，不是把对象写成整件。
  const notWhole = /不(?:追溯|针对|适用|包括|涵盖)[^，。；;]*?(?:整件|成品|整套|全套)/.test(text);
  if (notWhole) {
    const match = /不(?:追溯|针对|适用|包括|涵盖)[^，。；;]*?(?:整件|成品|整套|全套)/.exec(text);
    facts.push(fact('restriction:not-whole', true, '明确不追溯整件成品',
      spanOf(text, match), { recordId }));
  }

  // ---- 数值与单位 ----
  const quantities = [];
  const addQuantity = (match, value, unit, operator, rawUnit) => {
    const quantity = {
      value,
      unit,
      operator,
      raw: match[0],
      rawUnit,
      source: spanOf(text, match),
      recordId
    };
    quantities.push(quantity);
    facts.push(fact('quantity:value', quantity.value,
      `数值 ${quantity.value}`, quantity.source, { recordId, unit }));
    facts.push(fact('quantity:unit', unit,
      `单位 ${unitLabel(unit)}`, quantity.source, { recordId }));
    facts.push(fact('quantity:operator', operator,
      `比较 ${operatorLabel(operator)}`, quantity.source, { recordId }));
  };

  // 百分之二 / 2%
  collect(new RegExp(`${OPERATOR}\\s*百分之\\s*(${CN_NUMBER})`, 'g'), text, match => {
    const operator = operatorOf(match[1]);
    addQuantity(match, chineseToNumber(match[2]), 'percent', operator, '百分之');
  });
  collect(new RegExp(`${OPERATOR}\\s*(\\d+(?:\\.\\d+)?)\\s*%`, 'g'), text, match => {
    addQuantity(match, Number(match[2]), 'percent', operatorOf(match[1]), '%');
  });
  // 两毫米 / 2mm
  collect(new RegExp(`${OPERATOR}\\s*(${NUMBER})\\s*(毫米|公厘|mm)`, 'gi'), text, match => {
    addQuantity(match, chineseToNumber(match[2]), 'millimetre', operatorOf(match[1]), match[3]);
  });
  collect(new RegExp(`${OPERATOR}\\s*(${NUMBER})\\s*(厘米|cm)`, 'gi'), text, match => {
    addQuantity(match, chineseToNumber(match[2]), 'centimetre', operatorOf(match[1]), match[3]);
  });

  // 时长单独记录，避免把「半小时」当成尺寸数值。
  const durations = [];
  collect(new RegExp(`${OPERATOR}\\s*(半小时|半天|${NUMBER}\\s*(?:个)?(?:小时|钟头|分钟|天|日))`, 'g'), text, match => {
    let minutes;
    if (match[2] === '半小时') minutes = 30;
    else if (match[2] === '半天') minutes = 720;
    else {
      const numberMatch = new RegExp(NUMBER).exec(match[2]);
      const raw = numberMatch ? numberMatch[0] : '0';
      const factor = /小时|钟头/.test(match[2]) ? 60 : /天|日/.test(match[2]) ? 1440 : 1;
      minutes = chineseToNumber(raw) * factor;
    }
    const duration = {
      minutes,
      operator: operatorOf(match[1]),
      within: /内|以内/.test(text.slice(match.index, match.index + match[0].length + 1)),
      raw: match[0],
      source: spanOf(text, match),
      recordId
    };
    durations.push(duration);
    facts.push(fact('condition:duration', minutes, `浸湿/观察时长 ${minutes} 分钟`,
      duration.source, { recordId, operator: duration.operator }));
  });

  // ---- 情形 ----
  const waterMatches = [];
  collect(/遇水|清水|浸湿|水洗|泡水|淋水|沾水|水浸/g, text, match => {
    waterMatches.push(match);
  });
  const water = waterMatches.length > 0;
  for (const match of waterMatches) {
    facts.push(fact('condition:water', true, '情形为遇水/清水浸湿', spanOf(text, match), { recordId }));
  }

  // ---- 比较对象与否定 ----
  let subject = null;
  const lengthMatch = /长度(?:变化|改变|伸长|缩短)/.exec(text);
  const sizeMatch = /尺寸(?:变化|改变)|变形|形变/.exec(text);
  if (lengthMatch) {
    subject = 'length-change';
    facts.push(fact('comparison:subject', subject, '比较对象为长度变化',
      spanOf(text, lengthMatch), { recordId }));
  } else if (sizeMatch) {
    subject = 'dimension-change';
    facts.push(fact('comparison:subject', subject, '比较对象为尺寸/形状变化',
      spanOf(text, sizeMatch), { recordId }));
  }

  const negationMatch = /不变形|不会变形|无变形|不变化|不会变化|没有变化|尺寸不变|形状不变|不会改变/.exec(text);
  const negated = Boolean(negationMatch);
  const changeMatch = /(?:会|有|发生|出现)(?:有)?(?:尺寸|长度|形状)?(?:变化|改变|变形)/.exec(text);
  const affirmedChange = !negated && Boolean(changeMatch);
  if (negationMatch) {
    facts.push(fact('effect:negated', true, '否定表述：不变形/不变化',
      spanOf(text, negationMatch), { recordId }));
  }
  if (affirmedChange) {
    facts.push(fact('effect:affirmed-change', true, '肯定表述：会有变化',
      spanOf(text, changeMatch), { recordId }));
  }

  const comparison = quantities.length > 0
    ? {
        subject: subject ?? 'unspecified',
        operator: quantities[0].operator,
        value: quantities[0].value,
        unit: quantities[0].unit,
        source: quantities[0].source
      }
    : subject
      ? { subject, operator: null, value: null, unit: null, source: null }
      : null;

  // ---- 批次与限制 ----
  const batches = [];
  const knownBatches = new Set();
  for (const spec of specs) if (typeof spec?.batch === 'string') knownBatches.add(spec.batch);
  const batchPattern = new RegExp(`(?:${[...knownBatches].map(escapeRegExp).join('|')}|[春夏秋冬][甲乙丙丁])批?`, 'g');
  collect(batchPattern, text, match => {
    const batch = match[0].replace(/批$/, '');
    batches.push({ batch, source: spanOf(text, match) });
    facts.push(fact('restriction:batch', batch, `仅限批次 ${batch}`,
      spanOf(text, match), { recordId }));
  });

  const onlyMatch = /仅指|只针对|只限|仅限于|限定为|只检了|只测了|只适用于/.exec(text);
  const only = Boolean(onlyMatch);
  if (onlyMatch) {
    facts.push(fact('restriction:only', true, '有限定词：仅/只',
      spanOf(text, onlyMatch), { recordId }));
  }
  if (sample) {
    facts.push(fact('restriction:sample', true, '仅针对样条/样品',
      { start: sampleMatches[0].match.index, end: sampleMatches[0].match.index + sampleMatches[0].match[0].length,
        text: sampleMatches[0].match[0] }, { recordId }));
  }

  const restrictions = [];
  if (only) restrictions.push({ type: 'only', raw: onlyMatch[0], source: spanOf(text, onlyMatch) });
  for (const item of batches) restrictions.push({ type: 'batch', value: item.batch, source: item.source });
  if (sample) restrictions.push({ type: 'sample', source: facts.find(f => f.code === 'restriction:sample')?.source });
  if (notWhole) restrictions.push({ type: 'not-whole', source: null });
  if (part) restrictions.push({ type: 'part', value: part, source: null });

  const absolute = negated && quantities.length === 0 && comparison?.value == null;

  // 同一量词可能指材料性能，也可能指成品效果；没有对象线索时留给审阅人确认。
  // 同一量词（尤其百分比）用于材料性能还是成品效果，含义不同；
  // 文字里没有对象线索时不做推断，交给审阅人确认。
  const ambiguousQuantity = quantities.length > 0 && !part && !sample && !whole
    ? 'quantity-without-object'
    : null;

  return {
    id: recordId,
    text,
    object: {
      kind: objectKind,
      part,
      sample,
      whole,
      notWhole,
      materials: uniqueBy(materials, item => item.material).map(item => item.material),
      wholeMentions: uniqueBy(wholeMatches.map(() => 'whole'), item => item),
      sampleMentions: sampleMatches.map(item => item.value)
    },
    quantity: quantities[0] ?? null,
    quantities,
    durations,
    condition: {
      water,
      durationMinutes: durations[0]?.minutes ?? null,
      within: durations[0]?.within ?? false,
      raw: [waterMatches[0]?.[0], durations[0]?.raw].filter(Boolean).join(' ') || null
    },
    comparison,
    negated,
    affirmedChange,
    absolute,
    batch: batches[0]?.batch ?? null,
    batches: uniqueBy(batches.map(item => item.batch), value => value),
    only,
    restrictions,
    ambiguousQuantity,
    facts
  };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * 比较两份文案中的事实，指出新增、删去和保留的部分。
 * 只比较事实，不做批量文本替换。
 */
export function compareClaims(before, after) {
  const beforeFacts = factsByCode(before);
  const afterFacts = factsByCode(after);
  const added = [];
  const removed = [];
  const retained = [];
  const changed = [];

  const codes = new Set([...beforeFacts.keys(), ...afterFacts.keys()]);
  for (const code of codes) {
    const oldFacts = beforeFacts.get(code) ?? [];
    const newFacts = afterFacts.get(code) ?? [];
    const oldValues = new Set(oldFacts.map(factValue));
    const newValues = new Set(newFacts.map(factValue));

    for (const value of newValues) {
      if (!oldValues.has(value)) added.push(describeFact(code, value, newFacts, 'added'));
    }
    for (const value of oldValues) {
      if (!newValues.has(value)) removed.push(describeFact(code, value, oldFacts, 'removed'));
    }
    for (const value of newValues) {
      if (oldValues.has(value)) retained.push(describeFact(code, value, newFacts, 'retained'));
    }
  }

  // 单位、数值和对象的变化单独归为「更正」，避免被误读成普通新增/删除。
  const oldUnit = before.quantity?.unit;
  const newUnit = after.quantity?.unit;
  if (oldUnit && newUnit && oldUnit !== newUnit) {
    changed.push({
      code: 'quantity:unit',
      label: `单位由 ${unitLabel(oldUnit)} 改为 ${unitLabel(newUnit)}`,
      from: oldUnit,
      to: newUnit
    });
  }
  const correctionRemovals = new Set(oldUnit && newUnit && oldUnit !== newUnit
    ? ['quantity:unit', 'quantity:value'].filter(code =>
        code !== 'quantity:value' || before.quantity?.value === after.quantity?.value)
    : []);
  // 保留下来的事实不因单位更正而消失（数值相同）。
  for (const code of correctionRemovals) {
    for (let index = removed.length - 1; index >= 0; index -= 1) {
      if (removed[index].code !== code) continue;
      const [item] = removed.splice(index, 1);
      // 更正后的条目以「变化」呈现，不重复列为保留值。
      if (code !== 'quantity:unit') retained.push({ ...item, change: 'retained' });
    }
  }

  const beforeScope = [...(before.scope ?? [])].sort();
  const afterScope = [...(after.scope ?? [])].sort();
  const scopeAdded = afterScope.filter(id => !beforeScope.includes(id));
  const scopeRemoved = beforeScope.filter(id => !afterScope.includes(id));

  const temporal = new Set(['condition:water', 'condition:duration']);
  const addedRestrictions = added.some(item =>
    item.code.startsWith('restriction:') || item.code.startsWith('condition:'));
  // 时长变长或变短都是换了一个结论窗口，不能按「收窄」直接放行。
  const removedRestrictions = removed.some(item => item.code.startsWith('restriction:')
    || (temporal.has(item.code) && item.code !== 'condition:duration'
      && !added.some(newItem => newItem.code === item.code))
    || (item.code === 'condition:duration'
      && !added.some(newItem => newItem.code === 'condition:duration')));
  const widened = scopeAdded.length > 0 || removedRestrictions;
  const narrowed = scopeRemoved.length > 0 || addedRestrictions;
  const durationChanged = before.durations?.[0]?.minutes != null
    && after.durations?.[0]?.minutes != null
    && before.durations[0].minutes !== after.durations[0].minutes;
  let kind = 'preserved';
  if (widened && narrowed) kind = 'mixed';
  else if (durationChanged) kind = 'condition-changed';
  else if (widened) kind = 'widened';
  else if (narrowed && changed.length > 0) kind = 'narrowed-corrected';
  else if (narrowed) kind = 'narrowed';
  else if (changed.length > 0) kind = 'corrected';

  return {
    kind,
    safeToReview: !widened && !durationChanged,
    added,
    removed,
    retained,
    changed,
    scope: { before: beforeScope, after: afterScope, added: scopeAdded, removed: scopeRemoved }
  };
}

function factsByCode(claim) {
  const map = new Map();
  for (const item of claim.facts ?? []) {
    if (!map.has(item.code)) map.set(item.code, []);
    map.get(item.code).push(item);
  }
  return map;
}

function factValue(item) {
  return `${String(item.value)}`;
}

function describeFact(code, value, collection, change) {
  const item = collection.find(entry => factValue(entry) === value);
  return {
    code,
    value: item?.value ?? value,
    label: item?.label ?? `${code}=${value}`,
    change,
    source: item?.source ?? null
  };
}

export function unitLabel(unit) {
  return {
    percent: '百分比',
    millimetre: '毫米',
    centimetre: '厘米',
    metre: '米'
  }[unit] ?? unit ?? '（未标）';
}

export function operatorLabel(operator) {
  return { lt: '小于', lte: '不超过', gt: '大于', gte: '不少于', eq: '等于' }[operator] ?? operator;
}
