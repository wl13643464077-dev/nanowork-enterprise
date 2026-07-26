#!/usr/bin/env node
/**
 * One-time, field-allowlisted migration of legacy Paihuo employee skills.
 *
 * Usage:
 *   node scripts/export-paihuo-employee-skills.mjs \
 *     --db /absolute/read-only/contentcrew.db \
 *     --out server/catalog/employee-skills.json
 *
 * The legacy path is supplied by the operator and is never written into the
 * generated catalog. The query cannot read users, tenants, tasks, statistics,
 * prompts, settings secrets, or any other business table.
 */
import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const args = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  args.set(process.argv[index], process.argv[index + 1]);
}
const databasePath = args.get('--db');
const outputPath = args.get('--out');
if (!databasePath || !path.isAbsolute(databasePath) || !outputPath) {
  throw new Error('必须提供 --db 绝对只读数据库路径与 --out 输出路径');
}
if (!fs.statSync(databasePath).isFile()) throw new Error('只读数据库不存在');

const query = `
SELECT idx, skills_json, learned_at, settings_json, model_text, model_image
FROM employee_config
WHERE idx BETWEEN 0 AND 9 OR idx BETWEEN 101 AND 160
ORDER BY idx
`;
const rows = JSON.parse(execFileSync(
  'sqlite3',
  ['-json', `file:${databasePath}?immutable=1`, query],
  { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
));

const root = path.resolve(import.meta.dirname, '..');
const contentCatalog = JSON.parse(fs.readFileSync(path.join(root, 'server/catalog/content-crew.json'), 'utf8'));
const restaurantCatalog = JSON.parse(fs.readFileSync(path.join(root, 'server/catalog/restaurant.json'), 'utf8'));
const identities = new Map([
  ...contentCatalog.employees.map(employee => [employee.idx, {
    key: employee.key, name: employee.name, group: employee.group, department: '内容生产部',
  }]),
  ...restaurantCatalog.employees.map(employee => [employee.idx, {
    key: employee.key, name: employee.name, group: employee.group, department: restaurantCatalog.name,
  }]),
]);
const expectedIndexes = [
  ...Array.from({ length: 10 }, (_, index) => index),
  ...Array.from({ length: 60 }, (_, index) => index + 101),
];
if (rows.length !== expectedIndexes.length || rows.some((row, index) => row.idx !== expectedIndexes[index])) {
  throw new Error('employee_config白名单范围必须恰好覆盖idx 0-9与101-160');
}

const allowedTextModels = new Set(['', 'deepseek-v4-flash', 'gpt-5.5']);
const allowedImageModels = new Set(['', 'gpt-image-2']);
const snapshot = {
  date: '2026-07-18',
  sha256: crypto.createHash('sha256').update(fs.readFileSync(databasePath)).digest('hex'),
  kind: 'legacy_database_allowlist_export',
};

function safeSettings(raw, idx) {
  if (!raw) return {};
  const parsed = JSON.parse(raw);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error(`员工${idx}工作配置不是对象`);
  }
  const allowedKeys = new Set(['channels', 'targets', 'dimensions']);
  for (const [key, value] of Object.entries(parsed)) {
    if (!allowedKeys.has(key) || !Array.isArray(value) || value.some(item => typeof item !== 'string')) {
      throw new Error(`员工${idx}工作配置包含非白名单字段`);
    }
  }
  return parsed;
}

const profiles = rows.map(row => {
  const identity = identities.get(row.idx);
  if (!identity) throw new Error(`员工${row.idx}不在新项目静态目录`);
  const modelText = row.model_text || '';
  const modelImage = row.model_image || '';
  if (!allowedTextModels.has(modelText) || !allowedImageModels.has(modelImage)) {
    throw new Error(`员工${row.idx}包含未审核模型ID`);
  }
  const legacySkills = JSON.parse(row.skills_json || '[]');
  if (!Array.isArray(legacySkills) || !legacySkills.length) throw new Error(`员工${row.idx}没有历史技能`);
  const skills = legacySkills.map((skill, skillIndex) => {
    for (const field of ['title', 'detail', 'source']) {
      if (typeof skill[field] !== 'string' || !skill[field].trim()) {
        throw new Error(`员工${row.idx}技能${skillIndex}.${field}缺失`);
      }
    }
    if ((skill.learned_at !== null && typeof skill.learned_at !== 'number') || typeof skill.enabled !== 'boolean') {
      throw new Error(`员工${row.idx}技能${skillIndex}状态字段无效`);
    }
    return {
      title: skill.title,
      detail: skill.detail,
      source: skill.source,
      enabled: skill.enabled,
      learnedAt: skill.learned_at,
      verificationStatus: 'legacy_unverified',
      sourceSnapshot: snapshot,
    };
  });
  return {
    idx: row.idx,
    ...identity,
    learnedAt: typeof row.learned_at === 'number' ? row.learned_at : null,
    safeLegacyConfig: {
      modelText: modelText || null,
      modelImage: modelImage || null,
      settings: safeSettings(row.settings_json, row.idx),
    },
    expectedSkillCount: skills.length,
    skills,
  };
});

const contentSkillCount = profiles
  .filter(profile => profile.idx < 10)
  .reduce((sum, profile) => sum + profile.skills.length, 0);
const restaurantSkillCount = profiles
  .filter(profile => profile.idx >= 101)
  .reduce((sum, profile) => sum + profile.skills.length, 0);
const skillCount = contentSkillCount + restaurantSkillCount;
if (contentSkillCount !== 65 || restaurantSkillCount !== 344 || skillCount !== 409) {
  throw new Error(`历史技能数量不匹配：内容${contentSkillCount}/餐饮${restaurantSkillCount}/总计${skillCount}`);
}

const result = {
  schemaVersion: 'paihuo-employee-skills.v1',
  source: {
    project: '派活AI',
    snapshot,
    policy: 'Only employee_config idx 0-9 and 101-160 allowlisted skill/config fields were exported.',
  },
  employeeCount: profiles.length,
  skillCount,
  contentSkillCount,
  restaurantSkillCount,
  profiles,
};
fs.writeFileSync(path.resolve(root, outputPath), `${JSON.stringify(result, null, 2)}\n`, 'utf8');
