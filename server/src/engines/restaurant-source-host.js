// 这些平台不参与餐饮调研的页面或素材抓取，包括短链、静态资源及子域。
const excludedDomains = ['meituan.com', 'meituan.net', 'meituan.com.cn', 'dianping.com', 'dianping.cn', 'dpfile.com', 'meituanwaimai.com'];

export function excludedRestaurantSource(url) {
  let host;
  try { host = new URL(url).hostname.toLowerCase().replace(/\.+$/u, ''); }
  catch { return false; }
  return excludedDomains.some(domain => host === domain || host.endsWith('.' + domain));
}
