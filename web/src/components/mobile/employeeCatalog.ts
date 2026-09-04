import { api } from '../../api/client';

// 餐饮数字员工目录（GET /api/employees）的移动端读取：派活列表与任务详情都要用，
// 同一会话内共享一次请求结果；员工在岗状态会变，30 秒后再取会重新拉。

export type MobileEmployee = {
  idx: number;
  key: string;
  person: string;
  name: string;
  duty: string;
  desc?: string;
  intro?: string;
  group: string;
  color?: string;
  status?: string;
  currentTask?: string;
  business?: {
    intro?: string;
    cost?: { typicalCredits?: number; minCredits?: number; maxCredits?: number; typicalBasis?: string };
  } | null;
  inputs?: string[];
  deliverables?: string[];
  marshalId: number;
  specialistId: number;
  extension?: boolean;
};

export type MobileEmployeeCatalog = {
  total: number;
  groups: { name: string; emoji?: string; color?: string; count: number }[];
  employees: MobileEmployee[];
};

const CATALOG_TTL_MS = 30_000;
let cached: { at: number; data: MobileEmployeeCatalog } | null = null;
let inFlight: Promise<MobileEmployeeCatalog> | null = null;

function normalize(data: unknown): MobileEmployeeCatalog {
  if (Array.isArray(data)) return { total: data.length, groups: [], employees: data as MobileEmployee[] };
  const record = (data && typeof data === 'object' ? data : {}) as Partial<MobileEmployeeCatalog>;
  const employees = Array.isArray(record.employees) ? record.employees : [];
  return {
    total: Number(record.total ?? employees.length) || 0,
    groups: Array.isArray(record.groups) ? record.groups : [],
    employees,
  };
}

export function loadEmployeeCatalog(options: { force?: boolean } = {}): Promise<MobileEmployeeCatalog> {
  if (!options.force && cached && Date.now() - cached.at < CATALOG_TTL_MS) return Promise.resolve(cached.data);
  if (inFlight) return inFlight;
  inFlight = api
    .get('/employees', { silent: true })
    .then(raw => {
      const data = normalize(raw);
      cached = { at: Date.now(), data };
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  return inFlight;
}

export function findEmployeeByIdx(catalog: MobileEmployeeCatalog | null, idx: number | string | null | undefined) {
  const target = Number(idx);
  if (!catalog || !Number.isSafeInteger(target)) return null;
  return catalog.employees.find(item => Number(item.idx) === target) || null;
}

export function findEmployeeBySpecialist(catalog: MobileEmployeeCatalog | null, specialistId: unknown) {
  const target = Number(specialistId);
  if (!catalog || !Number.isSafeInteger(target) || target <= 0) return null;
  return catalog.employees.find(item => Number(item.specialistId) === target) || null;
}

export function employeeDisplayName(employee: Pick<MobileEmployee, 'person' | 'name'> | null | undefined) {
  if (!employee) return '';
  return String(employee.person || employee.name || '').trim();
}

// 分部色：按目录分部顺序循环取 8 个图表色（与桌面 Employees.tsx 同样按序分配，只是用 token）
export const DEPT_TONE_COUNT = 8;
export function deptToneIndex(catalog: MobileEmployeeCatalog | null, group: string) {
  const index = (catalog?.groups || []).findIndex(item => item.name === group);
  return index < 0 ? 0 : index % DEPT_TONE_COUNT;
}
