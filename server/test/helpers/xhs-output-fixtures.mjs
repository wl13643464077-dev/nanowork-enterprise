export const xhsFactPack = {
  facts: [
    { id: 'store:1:name', kind: 'store_name', claim: '门店名称：示例面馆', value: '示例面馆', usage: 'public', source: 'stores' },
    { id: 'dish:1:name', kind: 'dish_name', claim: '菜品名称：菌菇面', value: '菌菇面', usage: 'public', source: 'dishes' },
    { id: 'review:1', kind: 'review_quote', claim: '内部顾客原话', value: '昨天这碗面吃完我连汤都没有剩下', usage: 'internal_evidence', source: 'reviews' },
  ], missing: [],
};
export function xhsOutput(count = 3) {
  return {
    versions: ['痛点型', '场景型', '对比型', '测评型'].slice(0, count).map((strategy, index) => ({
      strategy, framework_ref: '痛点→场景→菜品→证据→行动',
      title: ['午饭选面先看这件事', '白领午饭的选面清单', '午饭选择先对照需求', '看菜单再决定午饭'][index],
      cover_text: ['选面有思路', '午餐选择题', '按需来选面', '看清再下单'][index],
      body: ['🍜 午饭还在纠结吗？',
        '忙完上午的事情，想给午饭留一点时间，不妨先把自己在意的选择条件列出来，再去核对菜单，不必只跟着别人的偏好走。',
        '示例面馆的菜品资料中有菌菇面，可以把这道菜放进自己的午餐候选清单，再结合当天的用餐安排决定要不要选择。',
        '这里依据的是门店名称和菜品名称资料，不代表个人到店体验。下单前请核对门店当日公示信息，再确认自己的饮食需求。',
        `把你${['选午饭时', '安排午餐时', '对照菜单时', '核对菜品时'][index]}在意的条件写在评论里，先从自己的需求开始选择。`].join('\n\n'),
      tags: ['午餐选择', '美食笔记', '面食', '菌菇面', '白领午饭', '用餐清单'],
      comment_prompt: '你选午饭时会先看菜单里的哪项信息？',
      facts_used: xhsFactPack.facts.slice(0, 2).map(f => ({ factId: f.id, claim: f.claim })),
      self_score: { hook: 3 + Number(index === 1), credibility: 4, conversion: 3, note: '依据已给门店资料组织选餐思路，效果需发布后验证；发布前提醒标注AI辅助创作。' },
    })),
    image_plan: [{ slot: '封面', desc: '用待确认授权的菜单图片说明午餐选择主题。' }, { slot: '内页', desc: '展示门店已授权的菌菇面图片，避免虚构实拍。' }],
  };
}
