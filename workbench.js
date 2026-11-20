// 工作台：读取资料，给出逐稿结论、系列汇总、改写建议和已上线内容的处置。
//
// 运行：node workbench.js [--materials 资料目录] [--json]

import { pathToFileURL } from 'node:url';
import { readMaterials } from './materials.js';
import { effectiveEvidence } from './evidence.js';
import { reviewListing, reviewSeries, suggestRewrite } from './review.js';

export async function buildWorkbench(directory) {
  const materials = await readMaterials(directory);
  const specs = materials['规格.json'];
  const evidenceRows = materials['依据.json'];
  const listings = materials['展位稿.json'];
  const constraints = materials['展示约束.json'];
  const { effective, corrections } = effectiveEvidence(evidenceRows, specs);

  const reviews = listings.map(row => reviewListing(row, specs, effective, constraints, listings));
  const rewrites = reviews.map(review => ({
    ...suggestRewrite(review, effective, constraints, reviews),
    status: review.status
  }));

  const seriesNames = [...new Set(specs.map(spec => spec.series))];
  const series = seriesNames.map(name => reviewSeries(name, specs, effective, listings, constraints));

  // 已上线文字的处置；保留的条目连同批准时采用的依据版本一起回查。
  const live = reviews.map(review => ({
    id: review.id,
    channel: review.channel,
    location: review.location,
    part: review.part,
    text: review.text,
    source: review.source,
    scopeIds: review.scopeIds,
    status: review.status,
    action: review.status === 'stop' ? '停止展示'
      : review.status === 'review' ? '暂缓，交审阅人确认'
      : '保留',
    reasons: review.problems.map(item => ({
      code: item.code,
      severity: item.severity,
      message: item.message,
      evidence: item.evidence ?? [],
      specs: item.specs ?? [],
      qualifiers: item.qualifiers ?? []
    })),
    basis: review.basis.covered.map(item => ({
      ...item,
      evidence: item.evidence.map(id => {
        const source = effective.find(entry => entry.id === id);
        return {
          id,
          issued: source?.issued ?? null,
          correctedOn: source?.validity?.correctedOn ?? null,
          unit: source?.quantity?.unit ?? null
        };
      })
    })),
    qualifiers: review.context
  }));

  // 已批准版本：保留时可回查当时采用的依据和有效期。
  const approvals = live.filter(item => item.status === 'keep').map(item => ({
    listingId: item.id,
    text: item.text,
    source: item.source,
    scope: item.scopeIds,
    evidence: item.basis
  }));

  return {
    generatedAt: new Date().toISOString(),
    evidence: {
      current: effective.map(item => ({
        id: item.id,
        issued: item.issued,
        correctedOn: item.validity?.correctedOn ?? null,
        text: item.text,
        quantity: item.quantity,
        batch: item.batch,
        part: item.part,
        sample: item.sample,
        notWhole: item.notWhole,
        affirmativeChange: item.affirmativeChange
      })),
      corrections: corrections.map(item => ({
        id: item.id,
        issued: item.issued,
        target: item.target,
        text: item.text,
        correction: item.correction
      }))
    },
    reviews,
    series,
    rewrites,
    live,
    approvals
  };
}

export function summarize(result) {
  const counts = { stop: 0, review: 0, keep: 0 };
  for (const item of result.live) counts[item.status] += 1;
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const argv = process.argv.slice(2);
  const materialsFlag = argv.indexOf('--materials');
  const directory = materialsFlag !== -1 && argv[materialsFlag + 1]
    ? pathToFileURL(argv[materialsFlag + 1].endsWith('/') ? argv[materialsFlag + 1] : `${argv[materialsFlag + 1]}/`)
    : undefined;
  try {
    const result = await buildWorkbench(directory);
    if (argv.includes('--json')) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      process.exitCode = 0;
    } else {
      const counts = summarize(result);
      process.stdout.write(`停止 ${counts.stop} 条，待确认 ${counts.review} 条，保留 ${counts.keep} 条\n`);
      for (const item of result.live) {
        process.stdout.write(`${item.id} ${item.channel}/${item.location}：${item.action}\n`);
        for (const reason of item.reasons) process.stdout.write(`  - ${reason.message}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
