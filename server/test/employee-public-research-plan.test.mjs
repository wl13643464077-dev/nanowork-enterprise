import assert from "node:assert/strict";
import { test } from "node:test";

import { compileEmployeePublicResearchPlan } from "../src/engines/employee-public-research-plan.js";

test("钱商圈把高德、点评/美团、窄门和等时圈技能编译成公开取证计划", () => {
  const secretDetail = "不得进入公开搜索查询的企业私有执行细节";
  const plan = compileEmployeePublicResearchPlan(
    {
      workbench: {
        identity: { idx: 102, name: "竞品与商圈画像" },
      },
      snapshot: {
        skills: [
          { id: "s-amap", title: "高德扫街榜竞对监测", detail: secretDetail },
          {
            id: "s-platform",
            title: "大众点评与美团商户核验",
            detail: secretDetail,
          },
          {
            id: "s-canyan",
            title: "窄门餐眼导出竞品对比表",
            source: "canyandata.com",
          },
          { id: "s-route", title: "驾车时圈替代同心圆", detail: secretDetail },
        ],
      },
    },
    { title: "太原毛血旺 吾悦广场" },
  );
  assert.equal(plan.employeeIdx, 102);
  assert.deepEqual(
    plan.lanes.map((lane) => lane.key),
    [
      "amap",
      "dianping",
      "meituan",
      "canyandata",
      "isochrone",
      "employee_skill_topics",
      "official_business",
    ],
  );
  assert.ok(plan.queries.some((query) => query.includes("site:dianping.com")));
  assert.ok(plan.queries.some((query) => query.includes("site:meituan.com")));
  assert.ok(
    plan.queries.some((query) => query.includes("site:canyandata.com")),
  );
  assert.ok(
    plan.queries.every((query) => query.includes("太原毛血旺 吾悦广场")),
  );
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(secretDetail, "u"));
  assert.deepEqual(plan.apiClaims, []);
});

test("公开取证任务要求已包含截断标题时不重复前缀，且不带入私有任务字段", () => {
  const title =
    "请评估在山西太原吾悦广场周边开一家粤菜餐厅的市场机会。计划核心商圈为步行15分钟、骑行20分钟、驾车30分钟";
  const privateNote = "PRIVATE-CUSTOMER-LIST-DO-NOT-SEARCH";
  const requirement = `${title}；堂食加外卖，午晚餐为主；目标客单60到100元；首店投资上限300万元；要求2026年9月11日前给出是否进入的决策。`;
  const plan = compileEmployeePublicResearchPlan(
    {
      workbench: {
        identity: { idx: 102, name: "竞品与商圈画像" },
      },
      snapshot: {
        skills: [{ id: "s-amap", title: "高德扫街榜竞对监测" }],
      },
    },
    {
      title,
      requirement,
      privateNotes: privateNote,
      internalCustomerProfile: privateNote,
    },
  );

  for (const query of plan.queries) {
    assert.equal(
      query.split(title).length - 1,
      1,
      `公开查询不应重复标题前缀：${query}`,
    );
    assert.match(query, /2026年9月11日前/u);
    assert.doesNotMatch(query, new RegExp(privateNote, "u"));
  }
});

const { compileLocationResearchQueries, interleaveResearchSources } = await import('../src/engines/employee-public-research-plan.js');
test('地点检索覆盖六种主题且结果不会被首个主题挤占', () => {
  // 没有技能计划时：六类客源查询全部保留；指定具体品类时再追加点评/美团菜单查询。
  const audienceOnly = compileLocationResearchQueries('北京酒仙桥', '川菜');
  assert.equal(audienceOnly.length, 8);
  for (const topic of ['餐厅', '商场', '写字楼', '住宅', '学校', '地铁']) assert.ok(audienceOnly.some(q => q.includes(topic)));
  assert.ok(audienceOnly.some(q => /site:dianping\.com/u.test(q)));
  assert.ok(audienceOnly.some(q => /site:meituan\.com/u.test(q)));
  assert.equal(compileLocationResearchQueries('北京酒仙桥', '餐饮').length, 6, '未指定具体品类时不追加平台菜单查询');
  // 岗位技能计划（高德/点评/美团/窄门…）是能力承诺，必须全部真实执行，排在前面，
  // 平台商户页优先；剩余预算再补六类客源查询。
  const skills = ['北京酒仙桥 川菜 高德地图 扫街榜', '北京酒仙桥 川菜 site:canyandata.com', '北京酒仙桥 川菜 site:dianping.com 菜单'];
  const withSkills = compileLocationResearchQueries('北京酒仙桥', '川菜', skills);
  assert.deepEqual(withSkills.slice(0, 3), [skills[2], skills[0], skills[1]]);
  assert.equal(withSkills.length, 10);
  // 技能计划超过预算时不被固定查询挤掉，客源查询让位。
  const queries = compileLocationResearchQueries('北京酒仙桥', '川菜', Array.from({length: 20}, (_, i) => `技能${i}`));
  assert.equal(queries.length, 14, '硬上限 14 条保护搜索供应商限流');
  assert.ok(queries.every(q => q.startsWith('技能')));
  const first = Array.from({length: 20}, (_, i) => ({url: `https://example.com/restaurant/${i}`}));
  const office = {url: 'https://example.com/office'};
  const school = {url: 'https://example.com/school'};
  const result = interleaveResearchSources([first, [first[0], office], [school]], 4);
  assert.deepEqual(result, [first[0], office, school, first[1]]);
  assert.deepEqual(compileLocationResearchQueries(''), []);
});
