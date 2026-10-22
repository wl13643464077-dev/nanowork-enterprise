import assert from "node:assert/strict";
import { test } from "node:test";

process.env.NANOWORK_TEST_TEMPLATE_AI = "1";
process.env.NANOWORK_DB = ":memory:";

const { publicResearchIncompleteBossMessage, GAP_PRESENTATION_RULE, GAP_PRESENTATION_HEADING } =
  await import("../src/engines/ai.js");

test("公开调研门禁未过：老板看到的是业务化原因 + 改一句话的建议，不是内部门禁术语", () => {
  const message = publicResearchIncompleteBossMessage(
    [
      "目标地点的地图来源没有形成可核验锚点",
      "目标地点相关的餐饮官方、平台或商户正文来源没有形成直接证据",
    ],
    { locationBusinessTask: true, locationIntent: { center: "酒仙桥" } },
  );
  assert.match(message, /报告未生成，积分已全额退回/u);
  assert.match(message, /地图没能把地点定位到具体位置/u);
  assert.match(message, /没读到目标地点周边可核验的商户\/平台页面正文/u);
  assert.match(message, /当前识别为“酒仙桥”/u);
  assert.match(message, /城市 \+ 商场\/路名 \+ 门牌或地标/u);
  assert.match(message, /写清品类或门店名/u);
  assert.doesNotMatch(message, /锚点|门禁|受控|contract|sourceQuality/iu);
});

test("公开调研门禁未过：联网检索不够时不要误导老板去改已经识别到的商场名", () => {
  const generic = publicResearchIncompleteBossMessage(["完全陌生的内部原因"], {});
  assert.match(generic, /公开渠道本轮没有取得足够可核验的资料/u);
  assert.match(generic, /晚些再试一次/u);
  const pages = publicResearchIncompleteBossMessage(
    ["尚未取得可供读取的网页候选来源"],
    { locationBusinessTask: true, locationIntent: { center: "深圳塘朗宝能城" } },
  );
  assert.match(pages, /公开网页检索没有命中与这个地点直接相关的内容/u);
  assert.doesNotMatch(pages, /把地点写得更具体/u);
  const search = publicResearchIncompleteBossMessage(
    ["360联网检索已执行，但没有返回可打开的真实网页候选"],
    { locationBusinessTask: true, locationIntent: { center: "深圳塘朗宝能城" } },
  );
  assert.match(search, /联网检索这轮没有搜到足够可打开的商户或平台网页/u);
  assert.doesNotMatch(search, /把地点写得更具体/u);
});

test("缺口呈现规范：集中清单、表格用—、摘要先讲拿到了什么", () => {
  assert.equal(GAP_PRESENTATION_HEADING, "## 待补数据与现场核实清单");
  assert.match(GAP_PRESENTATION_RULE, /真实性不变，只改呈现/u);
  assert.match(GAP_PRESENTATION_RULE, /第一句必须先讲本次已核验拿到了什么/u);
  assert.match(GAP_PRESENTATION_RULE, /统一写“—”/u);
  assert.match(GAP_PRESENTATION_RULE, /同一缺口只出现一次/u);
  assert.match(GAP_PRESENTATION_RULE, /不因为部分缺口把整份报告写成免责声明/u);
});
