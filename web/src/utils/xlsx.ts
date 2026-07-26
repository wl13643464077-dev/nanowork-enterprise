// xlsx 按需加载（约 478KB）：只有用户真正点到「导入/导出表格」时才拉取该 chunk，
// 不再随 Growth / Activities / DataIntake 页面首屏加载。
export type XlsxModule = typeof import('xlsx');

export const loadXlsx = (): Promise<XlsxModule> => import('xlsx');
