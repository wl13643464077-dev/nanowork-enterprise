// ===== 数字员工派活权限策略（任务5：员工使用权限）=====
// 老板/管理员在「角色与权限」里控制：哪些角色可以给哪个分部/哪位数字员工派活。
// 规则优先级：员工级覆盖 > 分部级规则 > 默认放行。
// boss / admin / platform_super 永远可派活（防止把管理者自己锁死）。
import { getTenantConfig, setTenantConfig } from '../db.js';

export const DISPATCH_POLICY_KEY = 'employee_dispatch_policy';
export const DISPATCHABLE_ROLES = Object.freeze(['boss', 'ops_director', 'sales', 'admin', 'partner']);
const ALWAYS_ALLOWED_ROLES = new Set(['boss', 'admin', 'platform_super']);
const EMPLOYEE_KEY_RE = /^(emp:(10[1-9]|1[1-5][0-9]|16[01])|crew:[0-9])$/;

function normalizeRoles(value) {
  if (!Array.isArray(value)) return null;
  const roles = [...new Set(value.map(item => String(item)))].filter(role => DISPATCHABLE_ROLES.includes(role));
  return roles;
}

// 载入策略（缺省：全员可派活，与历史行为一致）
export function dispatchPolicy(tenantId = undefined) {
  const raw = getTenantConfig(DISPATCH_POLICY_KEY, {}, tenantId) || {};
  const groups = {};
  if (raw.groups && typeof raw.groups === 'object' && !Array.isArray(raw.groups)) {
    for (const [name, rule] of Object.entries(raw.groups)) {
      const roles = normalizeRoles(rule?.roles);
      if (typeof name === 'string' && name.length <= 80 && roles) groups[name] = { roles };
    }
  }
  const employees = {};
  if (raw.employees && typeof raw.employees === 'object' && !Array.isArray(raw.employees)) {
    for (const [key, rule] of Object.entries(raw.employees)) {
      const roles = normalizeRoles(rule?.roles);
      if (EMPLOYEE_KEY_RE.test(key) && roles) employees[key] = { roles };
    }
  }
  return { defaultAllow: raw.defaultAllow !== false, groups, employees };
}

// 校验并保存（管理端 PUT）；返回归一化后的策略
export function saveDispatchPolicy(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw Object.assign(new Error('派活权限策略必须是对象'), { status: 400 });
  }
  const cleaned = { defaultAllow: input.defaultAllow !== false, groups: {}, employees: {} };
  if (input.groups && typeof input.groups === 'object' && !Array.isArray(input.groups)) {
    for (const [name, rule] of Object.entries(input.groups)) {
      if (typeof name !== 'string' || !name.trim() || name.length > 80) {
        throw Object.assign(new Error('分部名称不合法'), { status: 400 });
      }
      const roles = normalizeRoles(rule?.roles);
      if (!roles) throw Object.assign(new Error(`分部「${name}」的角色列表不合法`), { status: 400 });
      cleaned.groups[name.trim()] = { roles };
    }
  }
  if (input.employees && typeof input.employees === 'object' && !Array.isArray(input.employees)) {
    for (const [key, rule] of Object.entries(input.employees)) {
      if (!EMPLOYEE_KEY_RE.test(key)) {
        throw Object.assign(new Error(`员工标识「${key}」不合法（emp:101-161 或 crew:0-9）`), { status: 400 });
      }
      const roles = normalizeRoles(rule?.roles);
      if (!roles) throw Object.assign(new Error(`员工「${key}」的角色列表不合法`), { status: 400 });
      cleaned.employees[key] = { roles };
    }
  }
  setTenantConfig(DISPATCH_POLICY_KEY, cleaned);
  return cleaned;
}

/**
 * 判定用户能否给指定数字员工派活。
 * @param user     req.user（含 role）
 * @param employee { kind: 'restaurant'|'crew', idx, group }
 *                 餐饮员工 idx 101-161；内容员工 idx 0-9；group 为分部名（内容部固定'内容生产部'）
 */
export function canDispatchEmployee(user, employee) {
  if (!user?.id) return false;
  const role = String(user.role || '');
  if (ALWAYS_ALLOWED_ROLES.has(role)) return true;
  const policy = dispatchPolicy();
  const key = employee?.kind === 'crew' ? `crew:${employee.idx}` : `emp:${employee?.idx}`;
  const employeeRule = policy.employees[key];
  if (employeeRule) return employeeRule.roles.includes(role);
  const groupRule = employee?.group ? policy.groups[employee.group] : null;
  if (groupRule) return groupRule.roles.includes(role);
  return policy.defaultAllow;
}

// 派活被拒时的统一提示（前端直接展示）
export const DISPATCH_DENIED_MESSAGE = '当前角色未被授权给该数字员工派活，请联系老板或管理员在「角色与权限」中开通。';
